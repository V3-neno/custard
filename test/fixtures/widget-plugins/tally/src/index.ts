import { definePlugin } from 'custard-plugin-sdk'

let count = 0
const log: number[] = []

export default definePlugin({
  tools: {
    count: () => ({ content: `The tally is ${count}.`, data: { count, recent: log.slice(-5) } }),
    add: (i: { amount: number }, ctx) => {
      count += i.amount
      log.push(i.amount)
      // ctx.caller is set by Custard: "widget" here means a press in the widget.
      return {
        content: `Added ${i.amount} (from the ${ctx.caller}); the tally is ${count}.`,
        data: { count }
      }
    }
  }
})
