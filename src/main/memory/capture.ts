import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import type { CaptureJob, ChatMemory, Conversation, Provider } from '../../shared/chat'
import type { MemorySettings } from '../../shared/memory'
import { buildEvidence, eligible, evidenceText, type Evidence } from './evidence'
import { noteText, render, type Item, type Provenance, type Section } from './render'
import type { Summarizer } from './summarize'
import { CAPTURES, captureName, chatCaptures, deleteNotes, vaultId, writeCapture } from './write'

// Automatic memory: after a turn ends, a deterministic check decides whether
// the chat since the last capture is worth remembering. If so, one capture
// job is queued for the chat. A job summarizes that part of the chat with one
// tool-less model call and writes the result as a new note in the vault
// (Custard/Captures). It only creates notes, never edits one, and it never
// runs, repeats or resumes an action.
//
// Jobs live on the conversation (ChatMemory) and a small queue file holds the
// ids of chats with a job waiting, so a job survives a restart or a vault
// that isn't there right now. Only ids are queued; the evidence is rebuilt
// from the saved chat when the job runs, so turning memory off or deleting
// the chat stops it.

export const QUEUE_LIMIT = 50
export const MAX_ATTEMPTS = 3

export type CaptureDeps = {
  load: (id: string) => Conversation | null
  update: (id: string, change: (c: Conversation) => void) => Conversation | null
  vaultPath: () => string | null
  settings: () => MemorySettings
  summarizer: (provider: Provider) => Summarizer | null
  queueFile: string
  pluginName: (id: string) => string
  // The folder for a plugin's own capture notes (plugin knowledge); null to
  // keep its parts in the main capture note.
  pluginFolder?: (vault: string, pluginId: string) => string | null
  notify?: (c: Conversation) => void
  now?: () => number
}

const pad = (n: number): string => String(n).padStart(2, '0')
const localDate = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localTime = (t: number): string => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// What the chat said about not being remembered, as a skip reason. Asking to
// forget the whole chat also turns memory off for it.
const dontRememberReason = (e: Evidence): string =>
  e.forgetChat
    ? `Your message said "${e.dontRemember}", so Custard stopped remembering this chat. To delete what it saved earlier, use Forget.`
    : `Your message said "${e.dontRemember}", so this part wasn't saved.`

// A job is tied to the vault it was queued for: its id file, or its folder
// when it has no id yet.
const vaultKey = (vault: string): string => vaultId(vault, false) ?? `path:${vault}`

export class Capture {
  private queue: string[]
  private current: Promise<void> | null = null
  private next: Promise<void> | null = null
  // Chats whose job is running now, and those that had another turn meanwhile.
  private runningNow = new Set<string>()
  private again = new Set<string>()

  constructor(private deps: CaptureDeps) {
    this.queue = this.readQueue()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private readQueue(): string[] {
    try {
      const ids = JSON.parse(readFileSync(this.deps.queueFile, 'utf8'))
      return Array.isArray(ids) ? ids.filter((i) => typeof i === 'string').slice(-QUEUE_LIMIT) : []
    } catch {
      return []
    }
  }

  private writeQueue(): void {
    const tmp = `${this.deps.queueFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.queue))
    renameSync(tmp, this.deps.queueFile)
  }

  private enqueue(id: string): void {
    this.queue = [...this.queue.filter((q) => q !== id), id]
    // Too many waiting (a vault gone for a long time): the oldest are dropped
    // and say so, rather than piling up.
    while (this.queue.length > QUEUE_LIMIT) {
      const dropped = this.queue.shift()!
      this.set(dropped, (m) => {
        if (m.job?.status === 'pending')
          this.end(m, 'skipped', 'Too many chats were waiting to be remembered.')
      })
    }
    this.writeQueue()
  }

  private dequeue(id: string): void {
    this.queue = this.queue.filter((q) => q !== id)
    this.writeQueue()
  }

  pending(): string[] {
    return [...this.queue]
  }

  private set(id: string, change: (m: ChatMemory, c: Conversation) => void): Conversation | null {
    const c = this.deps.update(id, (c) => {
      c.memory ??= { watermark: 0 }
      change(c.memory, c)
    })
    if (c) this.deps.notify?.(c)
    return c
  }

  // Ends the current job and moves the watermark past it, so that part of
  // the chat is never captured again.
  private end(
    m: ChatMemory,
    status: CaptureJob['status'],
    reason?: string,
    notes?: string[]
  ): void {
    if (!m.job) return
    m.watermark = Math.max(m.watermark, m.job.to)
    m.job = {
      ...m.job,
      status,
      at: this.now(),
      ...(reason ? { reason } : {}),
      ...(notes ? { notes } : {})
    }
    delete m.job.plan
    if (status === 'saved' || status === 'pending') delete m.job.reason
  }

  // After a turn ends (finished, stopped, failed, cut off). Never throws.
  afterTurn(conversation: Conversation, provider: Provider): void {
    try {
      this.consider(conversation.id, provider)
    } catch (err) {
      console.error('Memory capture:', err)
    }
    // Also a chance for captures that were waiting (vault, key) to go ahead.
    if (this.queue.length) void this.run()
  }

  private consider(id: string, provider: Provider): void {
    if (this.runningNow.has(id)) {
      this.again.add(id)
      return
    }
    const c = this.deps.load(id)
    if (!c) return
    const m = c.memory ?? { watermark: 0 }
    const from = m.watermark
    const to = c.messages.length
    if (to <= from) return
    if (!this.deps.settings().auto || m.off) {
      const why = m.off ? 'Memory is off for this chat.' : 'Remember automatically is off.'
      this.set(id, (m) => {
        m.job = {
          id: `${id}:${from}-${to}`,
          from,
          to,
          status: 'off',
          attempts: 0,
          at: this.now(),
          reason: why
        }
        m.watermark = to
      })
      this.dequeue(id)
      return
    }
    // A job already summarized but not yet written finishes first, so its
    // entries keep their marker; the rest of the chat is looked at after.
    if (m.job?.status === 'pending' && m.job.plan) {
      this.again.add(id)
      this.enqueue(id)
      void this.run()
      return
    }
    const evidence = buildEvidence(c, from, to, this.deps.settings().offPlugins)
    if (evidence.dontRemember) {
      this.set(id, (m) => {
        m.job = {
          id: `${id}:${from}-${to}`,
          from,
          to,
          status: 'skipped',
          attempts: 0,
          at: this.now()
        }
        this.end(m, 'skipped', dontRememberReason(evidence))
        if (evidence.forgetChat) m.off = true
      })
      this.dequeue(id)
      return
    }
    if (!eligible(evidence)) return
    const vault = this.deps.vaultPath()
    if (!vault) {
      this.set(id, (m) => {
        m.job = {
          id: `${id}:${from}-${to}`,
          from,
          to,
          status: 'skipped',
          attempts: 0,
          at: this.now()
        }
        this.end(m, 'skipped', 'No vault is connected, so there was nowhere to save it.')
      })
      return
    }
    this.set(id, (m) => {
      m.job = {
        id: `${id}:${from}-${to}`,
        from,
        to,
        status: 'pending',
        attempts: 0,
        at: this.now(),
        vault: vaultKey(vault),
        provider
      }
    })
    this.enqueue(id)
    void this.run()
  }

  // Runs every queued job once. Called after a turn, at startup and when a
  // vault is connected; jobs that must wait stay queued.
  run(): Promise<void> {
    // One run at a time; a call during a run gets one more run after it.
    if (this.current)
      return (this.next ??= this.current.then(() => {
        this.next = null
        return this.run()
      }))
    this.current = this.runQueue().finally(() => (this.current = null))
    return this.current
  }

  private async runQueue(): Promise<void> {
    // Each queued chat once per run, including ones queued meanwhile.
    const seen = new Set<string>()
    for (;;) {
      const id = this.queue.find((q) => !seen.has(q))
      if (!id) break
      seen.add(id)
      this.runningNow.add(id)
      let keep = false
      try {
        keep = await this.runJob(id)
      } catch (err) {
        console.error('Memory capture:', err)
        keep = true
      } finally {
        this.runningNow.delete(id)
      }
      if (!keep) this.dequeue(id)
      // The chat had another turn while this ran: look at the rest of it
      // now (a job that is still waiting is left for the next run).
      if (this.again.delete(id) && !keep) {
        const provider = this.deps.load(id)?.memory?.job?.provider ?? 'claude'
        seen.delete(id)
        this.consider(id, provider)
      }
    }
  }

  // Returns true when the job should stay queued.
  private async runJob(id: string): Promise<boolean> {
    const c = this.deps.load(id)
    const job = c?.memory?.job
    if (!c || !job || job.status !== 'pending') return false
    const still = (): boolean => {
      const now = this.deps.load(id)
      return (
        this.deps.settings().auto &&
        now?.memory?.job?.id === job.id &&
        now.memory.job.status === 'pending' &&
        !now.memory.off
      )
    }
    if (!this.deps.settings().auto || c.memory?.off) {
      this.set(id, (m) =>
        this.end(
          m,
          'off',
          c.memory?.off ? 'Memory is off for this chat.' : 'Remember automatically is off.'
        )
      )
      return false
    }
    const vault = this.deps.vaultPath()
    if (!vault || !existsSync(vault)) {
      const why = "Your vault isn't available; it will be saved when it is."
      if (job.reason !== why)
        this.set(id, (m) => {
          if (m.job?.id === job.id) m.job.reason = why
        })
      return true
    }
    const key = vaultKey(vault)
    if (job.vault && job.vault !== key && job.vault !== `path:${vault}`) {
      this.set(id, (m) =>
        this.end(m, 'skipped', 'It was waiting for a different vault than the one connected now.')
      )
      return false
    }
    // From here on the vault has an id, so this job can't follow it elsewhere.
    try {
      vaultId(vault, true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.set(id, (m) => this.end(m, 'failed', `Couldn't write to the vault: ${msg}`))
      return false
    }

    let plan = job.plan
    if (!plan) {
      const evidence = buildEvidence(c, job.from, job.to, this.deps.settings().offPlugins)
      if (evidence.dontRemember) {
        this.set(id, (m) => {
          this.end(m, 'skipped', dontRememberReason(evidence))
          if (evidence.forgetChat) m.off = true
        })
        return false
      }
      const summarize = this.deps.summarizer(job.provider ?? 'claude')
      if (!summarize) {
        const why = "There's no API key to summarize it with; it will be saved once there is."
        if (job.reason !== why)
          this.set(id, (m) => {
            if (m.job?.id === job.id) m.job.reason = why
          })
        return true
      }
      // Counted before the call, so a crash during it still counts.
      const attempt = job.attempts + 1
      this.set(id, (m) => {
        if (m.job?.id === job.id) m.job.attempts = attempt
      })
      let summary
      try {
        summary = await summarize(evidenceText(evidence))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt >= MAX_ATTEMPTS) {
          this.set(id, (m) => {
            if (m.job?.id === job.id) this.end(m, 'failed', `Couldn't summarize it: ${msg}`)
          })
          return false
        }
        this.set(id, (m) => {
          if (m.job?.id === job.id) m.job.reason = `Will try again: ${msg}`
        })
        return true
      }
      // Turned off, forgotten or replaced while the model was answering.
      if (!still()) return false
      if (!summary.save) {
        this.set(id, (m) => this.end(m, 'skipped', 'Nothing in it needed remembering.'))
        return false
      }
      plan = render(summary, evidence, this.deps.pluginName)
      const p = plan
      this.set(id, (m) => {
        if (m.job?.id === job.id) m.job.plan = p
      })
    }
    if (!still()) return false
    let written: string[]
    try {
      written = this.write(vault, c, job.id, job.at, plan as Item[])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const attempt = job.attempts + (job.plan ? 1 : 0)
      this.set(id, (m) => {
        if (m.job?.id !== job.id) return
        m.job.attempts = Math.max(m.job.attempts, attempt)
        if (m.job.attempts >= MAX_ATTEMPTS)
          this.end(m, 'failed', `Couldn't write to the vault: ${msg}`)
        else m.job.reason = `Will try again: ${msg}`
      })
      return this.deps.load(id)?.memory?.job?.status === 'pending'
    }
    this.set(id, (m) => {
      if (m.job?.id === job.id) this.end(m, 'saved', undefined, written)
    })
    return false
  }

  // Writes a capture as new notes: one in Custard/Captures, plus one per
  // plugin that has its own folder. Each is created only if its name is
  // free and is never written again; a note already holding this job (a
  // crash after writing, before the job was recorded) counts as written.
  private write(vault: string, c: Conversation, jobId: string, at: number, plan: Item[]): string[] {
    const from: Provenance = {
      title: c.title,
      date: localDate(at),
      time: localTime(at),
      chatId: c.id
    }
    const parts = new Map<string, { folder: string; items: Item[] }>()
    const off = this.deps.settings().offPlugins
    for (const i of plan) {
      // Remembering this plugin was turned off after it was summarized.
      if (i.plugin && off.includes(i.plugin)) continue
      const folder = (i.plugin && this.deps.pluginFolder?.(vault, i.plugin)) || null
      const key = folder ? i.plugin : ''
      const part = parts.get(key) ?? { folder: folder ?? CAPTURES, items: [] }
      part.items.push({ ...i, section: i.section as Section })
      parts.set(key, part)
    }
    const name = captureName(from.date, from.time, c.title)
    return [...parts].map(([plugin, part]) =>
      writeCapture(
        vault,
        part.folder,
        name,
        noteText(part.items, from, {
          'custard-capture': jobId,
          chat: c.id,
          date: from.date,
          ...(plugin ? { plugin } : {})
        }),
        { job: jobId, plugin }
      )
    )
  }

  // "Don't remember this chat" (off) or back on. Turning it off cancels a
  // waiting capture and moves the watermark to the end, so nothing said so
  // far is captured later, even after turning it back on.
  // A forgotten chat stays off.
  setChatMemory(id: string, off: boolean): Conversation | null {
    if (!off && this.deps.load(id)?.memory?.forgotten) return this.deps.load(id)
    const c = this.set(id, (m, c) => {
      m.off = off
      if (off) {
        if (m.job?.status === 'pending') this.end(m, 'off', 'Memory is off for this chat.')
        m.watermark = c.messages.length
      }
    })
    if (off) this.dequeue(id)
    return c
  }

  // The notes "Forget this chat" would delete.
  savedNotes(id: string): string[] {
    const vault = this.deps.vaultPath()
    return vault ? chatCaptures(vault, id) : []
  }

  // "Forget this chat": memory goes off for good, nothing waiting is written,
  // and every capture note saved from it is deleted. Only the chat's own
  // record that it was forgotten is kept, none of what was in it. Returns
  // the notes deleted and any that couldn't be.
  forget(id: string): { deleted: string[]; left: string[] } {
    this.set(id, (m, c) => {
      m.off = true
      m.forgotten = true
      m.watermark = c.messages.length
      if (m.job) {
        delete m.job.plan
        delete m.job.notes
        delete m.job.reason
      }
      this.end(m, 'off', 'You asked Custard to forget this chat.')
    })
    this.dequeue(id)
    this.again.delete(id)
    const vault = this.deps.vaultPath()
    if (!vault) return { deleted: [], left: [] }
    const notes = chatCaptures(vault, id)
    const deleted = deleteNotes(vault, notes)
    return { deleted, left: notes.filter((n) => !deleted.includes(n)) }
  }

  // Remember automatically turned off: every waiting capture is cancelled.
  cancelAll(): void {
    for (const id of [...this.queue]) {
      if (this.runningNow.has(id)) continue
      this.set(id, (m) => {
        if (m.job?.status === 'pending') this.end(m, 'off', 'Remember automatically is off.')
      })
      this.dequeue(id)
    }
  }
}
