import { assert, test } from 'custard-plugin-sdk/testing'
import manifest from '../plugin.json'
import plugin from '../src/index'

// Safety contract tests for a BLOCKER revision, not history-navigation tests.
// Do not mistake these assertions for an implemented Back service.
test('native Previous explicitly excludes listening-history Back and retains approval', () => {
  const previous = manifest.tools.find((tool) => tool.name === 'previous_track')!
  assert(previous)
  assert.equal(previous.effect, 'write')
  assert.match(previous.description, /explicit request for Spotify's native Previous/)
  assert.match(previous.description, /NOT Back/)
  assert.match(previous.description, /History-based Back is unavailable/)
  assert.match(previous.description, /Clarify ambiguous/)
  assert.match(previous.description, /seek with position_ms=0/)
  assert.match(previous.label, /native Previous/)
})

test('blocked feature advertises no fake Back handler and requests no speculative history access', () => {
  assert.equal(manifest.tools.some((tool) => /^(history_back|back|back_track)$/.test(tool.name)), false)
  assert.equal(Object.keys(plugin.tools).some((name) => /^(history_back|back|back_track)$/.test(name)), false)
  assert.equal(manifest.auth.scopes.includes('user-read-recently-played'), false)
  assert.equal(manifest.permissions.storage, false)
  assert.deepEqual(Object.keys(plugin.tools).sort(), manifest.tools.map((tool) => tool.name).sort())
})
