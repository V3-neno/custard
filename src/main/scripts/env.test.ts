import { describe, expect, it } from 'vitest'
import { canSetEnv, scriptEnv } from './env'

const parent = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'C.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  OPENAI_API_KEY: 'sk-x',
  NODE_OPTIONS: '--require /tmp/evil.js',
  PYTHONPATH: '/tmp/evil',
  PYTHONSTARTUP: '/tmp/evil.py',
  LD_PRELOAD: '/tmp/evil.so',
  HTTPS_PROXY: 'http://user:pass@proxy',
  ELECTRON_RUN_AS_NODE: '1'
}

describe('script environment', () => {
  it('keeps only the allowlist on POSIX', () => {
    const env = scriptEnv(parent, { platform: 'linux' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C.UTF-8' })
  })

  it('keeps Windows system variables and drops keys', () => {
    const env = scriptEnv(
      {
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local',
        OPENAI_API_KEY: 'sk-x',
        NODE_OPTIONS: '-r x'
      },
      { platform: 'win32', pathPrefix: ['C:\\env\\Scripts'] }
    )
    expect(env).toEqual({
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local',
      Path: 'C:\\env\\Scripts;C:\\Windows'
    })
  })

  it("adds a script's own values but never loader or interpreter variables", () => {
    const env = scriptEnv(parent, {
      platform: 'linux',
      extra: {
        SCRAPER_TOKEN: 't',
        NODE_OPTIONS: 'x',
        PYTHONPATH: 'x',
        PATH: 'x',
        LD_PRELOAD: 'x',
        lower: 'x'
      }
    })
    expect(env.SCRAPER_TOKEN).toBe('t')
    expect(env.PATH).toBe('/usr/bin')
    for (const k of ['NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD', 'lower'])
      expect(env[k]).toBeUndefined()
    expect(canSetEnv('HTTPS_PROXY')).toBe(false)
    expect(canSetEnv('ELECTRON_RUN_AS_NODE')).toBe(false)
  })
})
