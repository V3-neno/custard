#!/usr/bin/env bash
# Runs a mock e2e test against the packaged Linux build with Chromium's
# sandbox ON (no --no-sandbox), as a non-root user. See test/platform/README.md.
#   sudo [FRONT_ROUTES="api.openai.com=8898"] test/platform/packaged-linux.sh <test .mjs> [user=ctest]
# Needs: root (to switch user and give the test its own hosts file), Linux
# mount namespaces (unshare), xvfb-run, openssl, `npm run build:unpack:test` done,
# and `npm i --no-save playwright`.
#
# Packaged builds pin api.anthropic.com and api.openai.com (L13); that stays
# on. Only inside this test's own mount namespace, /etc/hosts maps both hosts
# to 127.0.0.1, where test/platform/tls-front.mjs (a throwaway test CA,
# trusted through NODE_EXTRA_CA_CERTS) forwards to the mock on :8899. The
# machine's own /etc/hosts is not changed.
set -euo pipefail
TEST=${1:?test file}
U=${2:-ctest}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
W=/srv/custard-pkg-test
OUT=$W/out
id "$U" >/dev/null 2>&1 || useradd -m "$U"
[ "$(id -u "$U")" != 0 ] || { echo "the test user must not be root"; exit 1; }
mkdir -p $W
rm -rf $W/app $OUT && cp -a "$REPO/dist/linux-unpacked" $W/app
mkdir -p $OUT && cp -r "$REPO/plugin" $OUT/plugin && cp -r "$REPO/vault-template" $OUT/vault
if [ ! -f $W/ca.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=custard-test-ca" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
    -keyout $W/ca.key -out $W/ca.crt 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=api.anthropic.com" \
    -keyout $W/front.key -out $W/front.csr 2>/dev/null
  printf 'subjectAltName=DNS:api.anthropic.com,DNS:api.openai.com\nextendedKeyUsage=serverAuth\n' >$W/ext.cnf
  openssl x509 -req -in $W/front.csr -CA $W/ca.crt -CAkey $W/ca.key -CAcreateserial -days 7 \
    -extfile $W/ext.cnf -out $W/front.crt 2>/dev/null
fi
printf '127.0.0.1 localhost\n127.0.0.1 api.anthropic.com\n127.0.0.1 api.openai.com\n' >$W/hosts
chown -R "$U" $W && chmod 644 $W/*.crt $W/front.key $W/hosts && chmod 600 $W/ca.key && chmod 777 $OUT
cd "$REPO"
node test/e2e/interrupt-mock.mjs $OUT >$W/mock.log 2>&1 &
MOCK=$!
node test/platform/tls-front.mjs $W 443 ${FRONT_ROUTES:-} >$W/front.log 2>&1 &
FRONT=$!
trap 'kill $MOCK $FRONT 2>/dev/null || true' EXIT
sleep 1
unshare -m --propagation private bash -c "mount --bind $W/hosts /etc/hosts && \
  su '$U' -s /bin/bash -c \"cd '$REPO' && env -u NODE_OPTIONS -u HTTPS_PROXY -u https_proxy \
    -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
    CUSTARD_EXE=$W/app/custard NODE_EXTRA_CA_CERTS=$W/ca.crt \
    xvfb-run -a node '$TEST' $OUT $W/shots\""
