import { describe, it } from 'vitest'
import { registeredTests } from './testing'

// Runs every plugin's tests (plugin/<id>/tests/*.test.ts) under vitest, the
// same files Custard runs in a sandbox from Settings and the Plugins workspace.

const files = import.meta.glob('../../plugin/*/tests/*.test.ts')
const registry = registeredTests() as { name: string; fn: () => unknown }[]

for (const [path, load] of Object.entries(files)) {
  registry.length = 0
  await load()
  const cases = [...registry]
  describe(path.replace('../../', ''), () => {
    for (const c of cases) it(c.name, async () => void (await c.fn()))
  })
}
