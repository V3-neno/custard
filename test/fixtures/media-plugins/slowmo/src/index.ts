import { definePlugin, PluginError } from 'custard-plugin-sdk'
import { CLIP_WEBM, PNG } from './clip'

// DEVELOPMENT-ONLY media plugin for tests (test/fixtures/media-plugins). It
// stands for an asynchronous video service without contacting one. Words in
// the prompt script what happens:
//   reject     the submit is refused before anything is sent (data.sent false)
//   lost       the submit throws after "sending", so the outcome is unknown
//   garbled    the submit answers without a job reference
//   fail       the job fails at the second status check
//   url        the result comes back as an https link on media.example.com
//   evil-url   the result link points at a host the plugin may not reach
//   wrong-type the result says video/webm but is a PNG
//   fast       completed at the first status check
// Otherwise: pending, then running (50%), then completed.

type TestJob = {
  id: string
  key: string
  prompt: string
  operation: string
  checks: number
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  references: number
}

const has = (j: TestJob, word: string): boolean => new RegExp(`\\b${word}\\b`).test(j.prompt)

async function load(ctx: {
  storage: { get<T>(k: string): Promise<T | undefined> }
}): Promise<TestJob[]> {
  return (await ctx.storage.get<TestJob[]>('jobs')) ?? []
}

export default definePlugin({
  tools: {
    submit: async (
      i: { operation: string; prompt: string; idempotencyKey: string; references?: unknown[] },
      ctx
    ) => {
      if (/\breject\b/.test(i.prompt))
        return {
          content: 'The test service refused this prompt.',
          isError: true,
          data: { sent: false }
        }
      const jobs = await load(ctx)
      const job: TestJob = {
        id: `job-${jobs.length + 1}`,
        key: i.idempotencyKey,
        prompt: i.prompt,
        operation: i.operation,
        checks: 0,
        state: 'pending',
        references: i.references?.length ?? 0
      }
      await ctx.storage.set('jobs', [...jobs, job])
      if (/\blost\b/.test(i.prompt)) throw new PluginError('The connection dropped after sending.')
      if (/\bgarbled\b/.test(i.prompt)) return { content: 'Started.', data: { ok: true } }
      return {
        content: `Started ${job.id}.`,
        data: { remoteId: job.id, status: { state: 'pending' } }
      }
    },
    status: async (i: { remoteId: string }, ctx) => {
      const jobs = await load(ctx)
      const job = jobs.find((j) => j.id === i.remoteId)
      if (!job) throw new PluginError('No such job.')
      if (job.state === 'pending' || job.state === 'running') {
        job.checks++
        if (has(job, 'fail') && job.checks >= 2) job.state = 'failed'
        else if (has(job, 'fast') || job.checks >= 3) job.state = 'completed'
        else if (job.checks >= 2) job.state = 'running'
        await ctx.storage.set('jobs', jobs)
      }
      const data =
        job.state === 'running'
          ? { state: 'running', progress: 0.5 }
          : job.state === 'failed'
            ? { state: 'failed', reason: 'The test service failed this job.' }
            : { state: job.state }
      return { content: `${job.id} is ${job.state}.`, data }
    },
    result: async (i: { remoteId: string }, ctx) => {
      const job = (await load(ctx)).find((j) => j.id === i.remoteId)
      if (!job || job.state !== 'completed') throw new PluginError('Not finished.')
      const file = has(job, 'evil-url')
        ? { name: 'clip.webm', mime: 'video/webm', url: 'https://evil.example.net/clip.webm' }
        : has(job, 'url')
          ? { name: 'clip.webm', mime: 'video/webm', url: 'https://media.example.com/clip.webm' }
          : has(job, 'wrong-type')
            ? { name: 'clip.webm', mime: 'video/webm', base64: PNG }
            : { name: 'clip.webm', mime: 'video/webm', base64: CLIP_WEBM }
      return { content: 'Here is the video.', data: { files: [file] } }
    },
    cancel: async (i: { remoteId: string }, ctx) => {
      const jobs = await load(ctx)
      const job = jobs.find((j) => j.id === i.remoteId)
      if (!job) throw new PluginError('No such job.')
      if (job.state === 'pending' || job.state === 'running') job.state = 'cancelled'
      await ctx.storage.set('jobs', jobs)
      return { content: `${job.id} is ${job.state}.`, data: { state: job.state } }
    },
    jobs: async (_i, ctx) => {
      const jobs = await load(ctx)
      return {
        content: JSON.stringify(
          jobs.map(({ id, key, state, checks, references }) => ({
            id,
            key,
            state,
            checks,
            references
          }))
        )
      }
    }
  }
})
