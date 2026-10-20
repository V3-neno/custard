// The environment a script starts with. Custard's own environment can hold
// API keys, proxy credentials and NODE_OPTIONS / PYTHON* variables that change
// what an interpreter loads, so a script gets only an allowlist plus the
// values its config declares. This keeps keys out of reach by accident; it
// doesn't stop a script from reading files the user can read.

const KEEP_WIN = [
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS'
]
const KEEP_POSIX = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE'
]

// Names a script's own config can never set: they change how interpreters,
// the dynamic loader or package managers behave.
const BLOCKED =
  /^(PATH|PATHEXT|NODE_.*|NPM_.*|PYTHON.*|PIP_.*|VIRTUAL_ENV|LD_.*|DYLD_.*|ELECTRON_.*|CUSTARD_.*|COMSPEC|SYSTEMROOT|WINDIR|.*_PROXY|SSL_CERT_.*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/i
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

export function canSetEnv(name: string): boolean {
  return ENV_NAME.test(name) && !BLOCKED.test(name)
}

export function scriptEnv(
  from: NodeJS.ProcessEnv,
  o: { platform: NodeJS.Platform; pathPrefix?: string[]; extra?: Record<string, string> }
): Record<string, string> {
  const win = o.platform === 'win32'
  const keep = new Set((win ? KEEP_WIN : KEEP_POSIX).map((k) => k.toUpperCase()))
  const env: Record<string, string> = {}
  let path = ''
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue
    const K = k.toUpperCase()
    if (K === 'PATH') path = v
    else if (keep.has(K)) env[k] = v
  }
  const delim = win ? ';' : ':'
  env[win ? 'Path' : 'PATH'] = [...(o.pathPrefix ?? []), ...(path ? [path] : [])].join(delim)
  for (const [k, v] of Object.entries(o.extra ?? {}))
    if (canSetEnv(k) && typeof v === 'string') env[k] = v
  return env
}
