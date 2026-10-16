import { assert, test } from 'custard-plugin-sdk/testing'
import manifest from '../plugin.json'
import plugin from '../src/index'

// Safety contract tests: native Previous is not Back, and adding read-only
// history access (1.4.0) did not create a Back feature. Recently played cannot
// tell a heard song from a skipped one, so no history-navigation tool exists.
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

test('no Back handler exists; history scopes are read-only and storage stays off', () => {
  assert.equal(manifest.tools.some((tool) => /^(history_back|back|back_track|replay|play_track)$/.test(tool.name)), false)
  assert.equal(Object.keys(plugin.tools).some((name) => /^(history_back|back|back_track|replay|play_track)$/.test(name)), false)
  assert(manifest.auth.scopes.includes('user-read-recently-played'))
  assert(manifest.auth.scopes.includes('user-top-read'))
  assert.equal(manifest.permissions.storage, false)
  assert.deepEqual(Object.keys(plugin.tools).sort(), manifest.tools.map((tool) => tool.name).sort())
})

test('history tool descriptions forbid inferring skips, completion, adjacency or Back', () => {
  const history = manifest.tools.find((tool) => tool.name === 'recently_played')!
  assert.match(history.description, /LAGGING and POSSIBLY INCOMPLETE/)
  assert.match(history.description, /never infer skips, completion, adjacency/)
  assert.match(history.description, /Back/)
  assert.equal(history.effect, 'read')
})
