import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LIMITS,
  type Automation,
  type AutomationView,
  type PendingQuestion,
  type RunRecord
} from '../../../../shared/automations'
import { effortControl, formEffort, runModelText } from '../../../../shared/automationEffort'
import { chatModels, type ModelAvailability } from '../../../../shared/chat'
import { providerEffort, type Effort } from '../../../../shared/models'
import type { ListedModel } from '../../../../shared/adapter'
import { providerIds, providerNames } from '../../../../shared/providers'
import { REASONS } from '../chat/modelText'
import type { PluginStatus } from '../../../../shared/plugins'
import type { VaultGrant } from '../../../../shared/vaultGrants'
import { cleanError, danger, input, primary, secondary } from './ui'

const when = (t: number): string =>
  new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

const schedule = (a: Automation): string =>
  `${a.times.join(', ')}${a.days.length ? `, on day ${a.days.join(', ')} of the month` : ', every day'}${a.timezone ? ` (${a.timezone})` : ''}`

const STATUS: Record<RunRecord['status'], string> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  skipped: 'Skipped'
}

type Form = {
  id: string
  name: string
  skill: string
  model: string
  // The effort the form holds (saved as it is; none for a model that takes
  // none), and the one the automation had when opened (none for a new one
  // or one saved before there was a choice).
  effort?: Effort
  saved?: Effort
  times: string
  days: string
  timezone: string
  folders: string[]
  plugins: string[]
  runsPerDay: string
  catchUpRuns: string
}

const blank = (model: string, skill: string): Form => ({
  id: '',
  name: '',
  skill,
  model,
  ...(formEffort(model, undefined) ? { effort: formEffort(model, undefined) } : {}),
  times: '',
  days: '',
  timezone: '',
  folders: [],
  plugins: [],
  runsPerDay: String(DEFAULT_LIMITS.runsPerDay),
  catchUpRuns: String(DEFAULT_LIMITS.catchUpRuns)
})

const split = (s: string): string[] =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)

// Skills the user has Custard run on a schedule while it is open. Each one
// can change notes only in folders already allowed under "Editable folders",
// and use only the read tools of the plugins picked here.
export default function Automations(): React.JSX.Element {
  const [views, setViews] = useState<AutomationView[]>([])
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [grants, setGrants] = useState<VaultGrant[]>([])
  const [skills, setSkills] = useState<string[]>([])
  const [plugins, setPlugins] = useState<PluginStatus[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  // The models a run can use: the adapters' list, and which of them can be
  // used now (the same rules as the chat's picker; no provider is asked).
  const [models, setModels] = useState<Pick<ListedModel, 'id' | 'label' | 'provider'>[]>(() => [
    ...chatModels()
  ])
  const [availability, setAvailability] = useState<ModelAvailability[]>([])

  const refresh = useCallback(() => {
    window.custard.automations.list().then(setViews)
    window.custard.automations.questions().then(setQuestions)
    window.custard.vault.getGrants().then(setGrants)
    window.custard.vault.get().then((v) => setSkills(v?.skills ?? []))
    window.custard.plugins.list().then(setPlugins)
    window.custard.models
      .list()
      .then((l) => setModels(l.filter((m) => m.source === 'profile')))
      .catch(() => {})
    window.custard.models
      .availability()
      .then(setAvailability)
      .catch(() => {})
  }, [])
  const offFor = (id: string): ModelAvailability | undefined =>
    availability.find((a) => a.id === id && !a.available)
  useEffect(() => {
    refresh()
    return window.custard.automations.onChanged(refresh)
  }, [refresh])

  const readPlugins = plugins.filter(
    (p) => p.state === 'enabled' && p.tools.some((t) => t.effect === 'read')
  )

  const open = (a?: Automation): void => {
    setError(null)
    // Folders may have been allowed since this was last shown.
    refresh()
    if (!a)
      return setForm(
        blank(
          models.find((m) => !offFor(m.id))?.id ?? models[0]?.id ?? chatModels()[0].id,
          skills[0] ?? ''
        )
      )
    setForm({
      id: a.id,
      name: a.name,
      skill: a.skill,
      model: a.model,
      ...(formEffort(a.model, a.effort) ? { effort: formEffort(a.model, a.effort) } : {}),
      ...(a.effort ? { saved: a.effort } : {}),
      times: a.times.join(', '),
      days: a.days.join(', '),
      timezone: a.timezone ?? '',
      folders: a.folders,
      plugins: a.plugins,
      runsPerDay: String(a.limits.runsPerDay),
      catchUpRuns: String(a.limits.catchUpRuns)
    })
  }

  const save = async (): Promise<void> => {
    if (!form) return
    setError(null)
    const existing = views.find((v) => v.automation.id === form.id)?.automation
    // The effort is whatever the form shows: dropped from the copy of the
    // existing automation, then set only when the form holds one.
    const { effort: _was, ...rest } = existing ?? ({} as Partial<Automation>)
    void _was
    const r = await window.custard.automations.save({
      ...rest,
      ...(form.effort ? { effort: form.effort } : {}),
      id: form.id,
      name: form.name,
      skill: form.skill,
      model: form.model,
      times: split(form.times),
      days: split(form.days).map(Number),
      ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
      folders: form.folders,
      plugins: form.plugins,
      enabled: existing?.enabled ?? false,
      limits: {
        ...(existing?.limits ?? {}),
        runsPerDay: Number(form.runsPerDay),
        catchUpRuns: Number(form.catchUpRuns)
      }
    })
    if (r.ok) {
      setForm(null)
      refresh()
    } else setError(r.problem)
  }

  const run = async <T,>(p: Promise<T>): Promise<void> => {
    setError(null)
    try {
      await p
    } catch (e) {
      setError(cleanError(e))
    }
    refresh()
  }

  const toggle = (list: string[], v: string): string[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  return (
    <section className="mt-5">
      <h3 className="mb-1 text-sm font-medium">Automations</h3>
      <p className="mb-3 text-sm text-ash-300">
        Run a skill on a schedule. It runs only while Custard is open, on its own with nobody to
        ask: it can read your vault, change notes only in the editable folders you pick, and use
        only the read tools of the plugins you pick. When Custard was closed at a scheduled time,
        the newest missed runs happen when it opens (you set how many), marked catch-up; older ones
        are noted and passed to the first of them.
      </p>
      {questions.some((q) => q.status === 'open') && (
        <div className="mb-3">
          <h4 className="mb-1 text-xs font-medium text-ash-300">
            Waiting for your answer. Claude asks them in your next chat.
          </h4>
          <ul className="space-y-1.5" aria-label="Open questions">
            {questions
              .filter((q) => q.status === 'open')
              .map((q) => (
                <li
                  key={q.id}
                  className="flex items-start gap-2 rounded-lg border border-molten-500/40 bg-forge-900 px-3 py-1.5 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p>{q.question}</p>
                    <p className="text-xs text-ash-500">
                      {q.automationName}, {when(q.created)}
                      {q.path ? ` · ${q.path}` : ''}
                    </p>
                    {q.context && <p className="text-xs text-ash-400">{q.context}</p>}
                  </div>
                  <button
                    aria-label={`Drop question: ${q.question}`}
                    onClick={() => void run(window.custard.automations.dismissQuestion(q.id))}
                    className={`${danger} !px-2 !py-0.5 text-xs`}
                  >
                    Drop
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
      {questions.some((q) => q.status === 'answered') && (
        <details className="mb-3 text-xs text-ash-400">
          <summary className="cursor-pointer">
            Answered questions ({questions.filter((q) => q.status === 'answered').length})
          </summary>
          <ul className="mt-1 space-y-1" aria-label="Answered questions">
            {questions
              .filter((q) => q.status === 'answered')
              .slice(0, 10)
              .map((q) => (
                <li key={q.id}>
                  {q.question} <span className="text-ash-300">→ {q.answer}</span>
                </li>
              ))}
          </ul>
        </details>
      )}
      {views.length > 0 && (
        <ul className="mb-3 space-y-2" aria-label="Automations">
          {views.map(({ automation: a, state, running, runs }) => (
            <li
              key={a.id}
              className="rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                <span className="text-xs text-molten-300">
                  {running ? 'Running' : state.paused ? 'Paused' : a.enabled ? 'On' : 'Off'}
                </span>
              </div>
              <p className="text-xs text-ash-400">
                Skill {a.skill} · {schedule(a)}
              </p>
              {state.paused && <p className="mt-1 text-xs text-ember-600">{state.paused.reason}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  aria-label={`${a.enabled ? 'Turn off' : 'Turn on'} ${a.name}`}
                  onClick={() => void run(window.custard.automations.setEnabled(a.id, !a.enabled))}
                  className={`${secondary} !px-2 !py-0.5 text-xs`}
                >
                  {a.enabled ? 'Turn off' : 'Turn on'}
                </button>
                {state.paused && (
                  <button
                    aria-label={`Resume ${a.name}`}
                    onClick={() => void run(window.custard.automations.resume(a.id))}
                    className={`${secondary} !px-2 !py-0.5 text-xs`}
                  >
                    Resume
                  </button>
                )}
                <button
                  aria-label={`Run ${a.name} now`}
                  disabled={running}
                  onClick={() => void run(window.custard.automations.runNow(a.id))}
                  className={`${secondary} !px-2 !py-0.5 text-xs`}
                >
                  Run now
                </button>
                <button
                  aria-label={`Edit ${a.name}`}
                  onClick={() => open(a)}
                  className={`${secondary} !px-2 !py-0.5 text-xs`}
                >
                  Edit
                </button>
                <button
                  aria-label={`Delete ${a.name}`}
                  onClick={() => {
                    if (confirm !== a.id) return setConfirm(a.id)
                    setConfirm(null)
                    void run(window.custard.automations.remove(a.id))
                  }}
                  className={`${danger} !px-2 !py-0.5 text-xs`}
                >
                  {confirm === a.id ? 'Delete it and its records?' : 'Delete'}
                </button>
              </div>
              {runs.length > 0 && (
                <details className="mt-2 text-xs text-ash-400">
                  <summary className="cursor-pointer">Runs ({runs.length})</summary>
                  <ul className="mt-1 space-y-1.5" aria-label={`Runs of ${a.name}`}>
                    {runs.map((r) => (
                      <li key={r.id} className="rounded border border-forge-700 px-2 py-1">
                        <div className="flex gap-2">
                          <span className="text-ash-300">{STATUS[r.status]}</span>
                          <span>{when(r.startedAt)}</span>
                          {r.kind === 'manual' && <span>started by you</span>}
                          {r.catchUp && <span>catch-up for {r.slot?.replace('T', ' ')}</span>}
                        </div>
                        {runModelText(r) && <p data-run-model>{runModelText(r)}</p>}
                        {r.reason && <p className="text-ash-300">{r.reason}</p>}
                        {r.calls.length > 0 && (
                          <p>
                            Read and did:{' '}
                            {r.calls
                              .map((c) =>
                                c.outcome === 'completed' ? c.label : `${c.label} (${c.outcome})`
                              )
                              .join('; ')}
                          </p>
                        )}
                        {r.changes.length > 0 && (
                          <p className="text-molten-200">
                            Changed: {r.changes.map((c) => `${c.path} (${c.kind})`).join(', ')}.
                            Find what changed, and Undo, under Recent changes.
                          </p>
                        )}
                        {r.summary && (
                          <p className="whitespace-pre-wrap text-ash-300">{r.summary}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <div className="space-y-2 rounded-lg border border-forge-700 bg-forge-900 p-3">
          <input
            aria-label="Automation name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Name, like Listening log"
            className={input}
          />
          <div className="flex gap-2">
            <select
              aria-label="Skill to run"
              value={form.skill}
              onChange={(e) => setForm({ ...form, skill: e.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-forge-700 bg-forge-900 px-2 py-2 text-sm outline-none"
            >
              {!skills.includes(form.skill) && (
                <option value={form.skill}>{form.skill || 'Pick a skill'}</option>
              )}
              {skills.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              aria-label="Model for the automation"
              value={form.model}
              onChange={(e) => {
                const { effort: _old, ...f } = form
                void _old
                const effort = formEffort(e.target.value, form.effort)
                setForm({ ...f, model: e.target.value, ...(effort ? { effort } : {}) })
              }}
              className="rounded-lg border border-forge-700 bg-forge-900 px-2 text-sm outline-none"
            >
              {!models.some((m) => m.id === form.model) && (
                <option value={form.model}>
                  {form.model} · {REASONS['no-profile']('')}
                </option>
              )}
              {providerIds.map((p) => (
                <optgroup key={p} label={providerNames[p]}>
                  {models
                    .filter((m) => m.provider === p)
                    .map((m) => {
                      const off = offFor(m.id)
                      return (
                        <option key={m.id} value={m.id} disabled={!!off && m.id !== form.model}>
                          {m.label}
                          {off?.reason ? ` · ${REASONS[off.reason](providerNames[p])}` : ''}
                        </option>
                      )
                    })}
                </optgroup>
              ))}
            </select>
          </div>
          {(() => {
            // The model's effort levels, as the model picker shows them:
            // a row of buttons, greyed out with the reason for a model
            // that takes none.
            const c = effortControl(
              form.model,
              form.saved,
              !form.id,
              form.effort,
              providerEffort(models.find((m) => m.id === form.model)?.provider ?? 'claude')
            )
            const name = models.find((m) => m.id === form.model)?.label ?? form.model
            return (
              <fieldset data-automation-effort={c.kind} className="max-w-sm">
                <legend className="mb-1 text-xs text-ash-400">
                  {c.kind === 'levels' ? `Effort for ${name}` : c.note}
                </legend>
                {c.kind !== 'no-profile' && (
                  <div className="flex gap-1">
                    {c.levels.map((l) => {
                      const on = c.kind === 'levels' && c.picked === l.value
                      return (
                        <button
                          key={l.value}
                          type="button"
                          aria-pressed={on}
                          data-level={l.value}
                          disabled={c.kind !== 'levels'}
                          onClick={() => setForm({ ...form, effort: l.value })}
                          className={`flex-1 rounded-full border px-1.5 py-1 text-xs disabled:opacity-40 ${
                            on
                              ? 'border-molten-500/60 text-molten-200'
                              : 'border-forge-700 text-ash-300 hover:text-molten-200'
                          }`}
                        >
                          {l.label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {c.kind === 'levels' && (
                  <p className="mt-1 text-xs text-ash-500" data-effort-cost>
                    {c.cost}
                  </p>
                )}
                {c.kind === 'levels' && c.note && (
                  <p className="text-xs text-ash-400" data-effort-note>
                    {c.note}
                  </p>
                )}
              </fieldset>
            )
          })()}
          <input
            aria-label="Times of day"
            value={form.times}
            onChange={(e) => setForm({ ...form, times: e.target.value })}
            placeholder="Times, like 07:30, 19:00 (24-hour, your time zone)"
            className={input}
          />
          <div className="flex gap-2">
            <input
              aria-label="Days of the month"
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}
              placeholder="Days of the month, like 1, 15 (empty = every day)"
              className={input}
            />
            <input
              aria-label="Time zone"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Time zone (empty = this computer's)"
              className={input}
            />
            <input
              aria-label="Runs per day"
              type="number"
              min={1}
              max={96}
              value={form.runsPerDay}
              onChange={(e) => setForm({ ...form, runsPerDay: e.target.value })}
              title="At most this many scheduled runs a day"
              className={`${input} !w-24`}
            />
            <input
              aria-label="Catch-up runs"
              type="number"
              min={0}
              max={10}
              value={form.catchUpRuns}
              onChange={(e) => setForm({ ...form, catchUpRuns: e.target.value })}
              title="When Custard was closed, how many missed runs to run on opening (the newest; 0 = none)"
              className={`${input} !w-24`}
            />
          </div>
          <fieldset>
            <legend className="mb-1 text-xs text-ash-400">Folders it may change</legend>
            {grants.length === 0 && (
              <p className="text-xs text-ash-500">
                None. Allow a folder under Editable folders first.
              </p>
            )}
            {grants.map((g) => (
              <label key={g.folder} className="mr-3 inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Folder ${g.folder}`}
                  checked={form.folders.includes(g.folder)}
                  onChange={() => setForm({ ...form, folders: toggle(form.folders, g.folder) })}
                />
                {g.folder}/ ({g.mode})
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-xs text-ash-400">
              Plugins it may read from (read tools only)
            </legend>
            {readPlugins.length === 0 && (
              <p className="text-xs text-ash-500">No enabled plugin has read tools.</p>
            )}
            {readPlugins.map((p) => (
              <label key={p.id} className="mr-3 inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Plugin ${p.name}`}
                  checked={form.plugins.includes(p.id)}
                  onChange={() => setForm({ ...form, plugins: toggle(form.plugins, p.id) })}
                />
                {p.name}
                {p.chatDesign !== 'on' && (
                  <span className="text-xs text-ash-500">
                    {' '}
                    (turn on “Use in Chat and Design” first)
                  </span>
                )}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button onClick={() => void save()} className={primary}>
              Save automation
            </button>
            <button onClick={() => setForm(null)} className={secondary}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => open()} className={secondary}>
          New automation
        </button>
      )}
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
    </section>
  )
}
