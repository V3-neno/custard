import { defineWidget } from 'custard-plugin-sdk/widget'

export default defineWidget({
  mount() {
    // A busy loop: the view never says it's ready and stops responding.
    for (;;) {
      /* spin */
    }
  }
})
