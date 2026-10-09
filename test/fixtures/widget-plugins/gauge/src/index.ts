import { definePlugin } from 'custard-plugin-sdk'

export default definePlugin({
  tools: { scale: () => 'The gauge goes from 0 to 100.' }
})
