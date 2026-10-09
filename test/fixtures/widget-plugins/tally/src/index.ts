import { definePlugin } from 'custard-plugin-sdk'

let count = 0
const log: number[] = []

export default definePlugin({
  tools: {
    count: () => ({ content: `The tally is ${count}.`, data: { count, recent: log.slice(-5) } }),
    add: (i: { amount: number }) => {
      count += i.amount
      log.push(i.amount)
      return { content: `Added ${i.amount}; the tally is ${count}.`, data: { count } }
    }
  }
})
