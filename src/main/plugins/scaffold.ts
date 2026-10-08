import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PLUGIN_API_VERSION } from '../../shared/plugins'
import { PLUGIN_ID } from './manifest'

// A new plugin folder with a working read-only tool and a test, so the first
// Validate and Test pass before anything is written.

export function scaffoldPlugin(root: string, id: string, name: string): string {
  if (!PLUGIN_ID.test(id))
    throw new Error('Use 2 to 31 lowercase letters, digits or hyphens, starting with a letter.')
  const clean = name.trim().slice(0, 60) || id
  const dir = join(root, id)
  if (existsSync(dir)) throw new Error(`plugin/${id} already exists.`)
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'))
  const manifest = {
    manifestVersion: 1,
    id,
    name: clean,
    description: `${clean} for Custard.`,
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    entry: 'src/index.ts',
    instructions: 'instructions.md',
    permissions: { network: [], openExternal: [], storage: false },
    config: {},
    tools: [
      {
        name: 'hello',
        description: 'Say hello. Replace this with a real tool.',
        effect: 'read',
        label: 'Said hello to {name}',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', maxLength: 100 } },
          required: ['name']
        }
      }
    ]
  }
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `import { definePlugin } from 'custard-plugin-sdk'

export default definePlugin({
  tools: {
    hello: ({ name }: { name: string }) => \`Hello, \${name}!\`
  }
})
`
  )
  writeFileSync(
    join(dir, 'tests', 'index.test.ts'),
    `import { assert, createContext, test } from 'custard-plugin-sdk/testing'
import plugin from '../src/index'

test('hello greets by name', async () => {
  assert.equal(await plugin.tools.hello({ name: 'Neno' }, createContext()), 'Hello, Neno!')
})
`
  )
  writeFileSync(
    join(dir, 'instructions.md'),
    `When to use the ${clean} tools, and any rules for them.\n`
  )
  writeFileSync(
    join(dir, 'README.md'),
    `# ${clean}\n\nWhat this plugin does, its permissions and how to set it up.\n`
  )
  return dir
}
