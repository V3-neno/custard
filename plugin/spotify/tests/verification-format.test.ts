import { assert, test } from 'custard-plugin-sdk/testing'
import { verificationLine } from '../src/verify'

// Regression: the detail used to run straight into the caveat ("reported paused Single snapshot: ...").
test('verification line separates the detail from the caveat with exactly one full stop', () => {
  const plain = verificationLine({ state: 'confirmed', detail: 'reported paused' })
  assert.match(plain, /^verification: confirmed — reported paused\. Single snapshot: /)
  const dotted = verificationLine({ state: 'not_observed', detail: 'still playing.' })
  assert.match(dotted, /— still playing\. Single snapshot: /)
  assert.notMatch(dotted, /\.\./)
  const spaced = verificationLine({ state: 'inconclusive', detail: 'the read failed (x)  ' })
  assert.match(spaced, /\(x\)\. Single snapshot: /)
})
