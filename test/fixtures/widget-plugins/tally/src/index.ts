import { definePlugin } from 'custard-plugin-sdk'

let count = 0
const log: number[] = []

export default definePlugin({
  tools: {
    count: () => ({ content: `The tally is ${count}.`, data: { count, recent: log.slice(-5) } }),
    add: async (i: { amount: number }, ctx) => {
      count += i.amount
      log.push(i.amount)
      // ctx.caller is set by Custard: "widget" here means a press in the widget.
      // The event log is the user's to turn on (Manage); off, nothing is kept.
      if (ctx.events.enabled)
        await ctx.events.append({
          at: new Date().toISOString(),
          record: { type: 'add', amount: i.amount, source: ctx.caller, title: 'Cups [[Memory]] #x' }
        })
      return {
        content: `Added ${i.amount} (from the ${ctx.caller}); the tally is ${count}.`,
        data: { count }
      }
    }
  }
})
