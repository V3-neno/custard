import { defineWidget } from 'custard-plugin-sdk/widget'

export default defineWidget({
  mount() {
    throw new Error('crash-on-mount-3381')
  }
})
