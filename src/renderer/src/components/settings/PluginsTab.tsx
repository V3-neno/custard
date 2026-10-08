import { useCallback, useEffect, useState } from 'react'
import {
  describePermission,
  type ConfigField,
  type PluginReview,
  type PluginStatus,
  type TestReport
} from '../../../../shared/plugins'
import { cleanError, danger, input, primary, secondary } from './ui'
import type { MemorySettings } from '../../../../shared/memory'

const stateLabel: Record<PluginStatus['state'], string> = {
  'not-activated': 'Not activated',
  enabled: 'Enabled',
  disabled: 'Disabled'
}

const when = (t: number): string =>
  new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

function Badge({ p }: { p: PluginStatus }): React.JSX.Element {
  const color =
    p.state === 'enabled'
      ? p.running
        ? 'text-molten-300'
        : 'text-ember-600'
      : p.sourceErrors.length
        ? 'text-ember-600'
        : 'text-ash-500'
  const text =
    p.state === 'enabled' && !p.running
      ? 'Enabled · not running'
      : p.sourceErrors.length && p.state === 'not-activated'
        ? 'Has problems'
        : stateLabel[p.state]
  return <span className={`text-xs ${color}`}>{text}</span>
}

// "Remember activity for this plugin": part of Custard's memory settings.
function PluginMemory({ p }: { p: PluginStatus }): React.JSX.Element {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  useEffect(() => {
    window.custard.memory.getSettings().then(setSettings)
  }, [])
  const on = settings ? !settings.offPlugins.includes(p.id) : true
  return (
    <section className="mb-5">
      <h4 className="mb-1 text-sm font-medium">Memory</h4>
      <label className="flex items-start gap-2 text-sm text-ash-300">
        <input
          type="checkbox"
          className="mt-1"
          aria-label={`Remember activity for ${p.name}`}
          checked={on}
          disabled={!settings}
          onChange={(e) => {
            const offPlugins = settings!.offPlugins.filter((x) => x !== p.id)
            if (!e.target.checked) offPlugins.push(p.id)
            const next = { ...settings!, offPlugins }
            setSettings(next)
            window.custard.memory.setSettings(next)
          }}
        />
        <span>
          Remember activity for this plugin. What you ask {p.name} to do, what it reports and how it
          turned out go to its folder under Custard/Plugins in your vault after chats, and relevant
          notes are shown to the assistant when you use it again.
        </span>
      </label>
      {!on && (
        <p className="mt-1 text-xs text-ash-500">
          Off: its actions are left out of what Custard remembers. Notes already in your vault stay
          until you edit them.
        </p>
      )}
    </section>
  )
}

function ConfigForm({
  p,
  onSaved
}: {
  p: PluginStatus
  onSaved: (s: PluginStatus) => void
}): React.JSX.Element | null {
  const fields = Object.entries(p.config.fields)
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (!fields.length) return null

  const current = (k: string, f: ConfigField): string | number | boolean =>
    k in values
      ? values[k]
      : f.secret
        ? ''
        : (p.config.values[k] ?? (f.type === 'boolean' ? false : ''))
  const set = (k: string, v: string | number | boolean): void => {
    setSaved(false)
    setValues((x) => ({ ...x, [k]: v }))
  }
  const save = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      setError(null)
      onSaved(await window.custard.plugins.setConfig(p.id, patch))
      setValues({})
      setSaved(true)
    } catch (e) {
      setError(cleanError(e))
    }
  }

  return (
    <section className="mb-5">
      <h4 className="mb-2 text-sm font-medium">Configuration</h4>
      <div className="flex flex-col gap-3">
        {fields.map(([k, f]) => (
          <label key={k} className="block text-sm">
            <span className="text-ash-200">
              {f.title}
              {f.secret && (
                <span className="ml-2 text-xs text-ash-500">
                  {p.config.secretsSet.includes(k) ? 'saved in secure storage' : 'not set'}
                </span>
              )}
            </span>
            {f.description && <span className="block text-xs text-ash-500">{f.description}</span>}
            <div className="mt-1 flex gap-2">
              {f.type === 'boolean' ? (
                <input
                  type="checkbox"
                  aria-label={f.title}
                  checked={current(k, f) === true}
                  onChange={(e) => set(k, e.target.checked)}
                />
              ) : f.enum ? (
                <select
                  aria-label={f.title}
                  className={input}
                  value={String(current(k, f))}
                  onChange={(e) => set(k, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {f.enum.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={f.title}
                  type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  className={`${input} font-mono text-xs`}
                  placeholder={
                    f.secret && p.config.secretsSet.includes(k) ? 'Paste to replace' : ''
                  }
                  value={String(current(k, f))}
                  onChange={(e) =>
                    set(k, f.type === 'number' ? Number(e.target.value) : e.target.value)
                  }
                />
              )}
              {f.secret && p.config.secretsSet.includes(k) && (
                <button className={danger} onClick={() => save({ [k]: null })}>
                  Remove
                </button>
              )}
            </div>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          className={primary}
          disabled={!Object.keys(values).length}
          onClick={() => save(values)}
        >
          Save configuration
        </button>
        {saved && <span className="text-xs text-ash-400">Saved.</span>}
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
    </section>
  )
}

function Review({
  p,
  onDone,
  onCancel
}: {
  p: PluginStatus
  onDone: (s: PluginStatus) => void
  onCancel: () => void
}): React.JSX.Element {
  const [review, setReview] = useState<PluginReview | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [tests, setTests] = useState<TestReport | null>(null)
  const [busy, setBusy] = useState<string | null>('Validating and building…')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    window.custard.plugins
      .review(p.id)
      .then(setReview, (e) => setError(cleanError(e)))
      .finally(() => setBusy(null))
  }, [p.id])

  const runTests = async (): Promise<void> => {
    setBusy('Running tests in a sandbox…')
    try {
      setTests(await window.custard.plugins.test(p.id))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }
  const activate = async (): Promise<void> => {
    if (!review?.buildId) return
    setBusy('Activating…')
    setError(null)
    try {
      onDone(await window.custard.plugins.activate(p.id, review.buildId, [...ticked]))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  const allTicked = review?.newPermissions.every((x) => ticked.has(x)) ?? false
  return (
    <div>
      <h4 className="mb-1 text-sm font-medium">Review {p.name}</h4>
      <p className="mb-4 text-xs text-ash-400">
        Plugins are code that runs on this computer. Custard checks the manifest and builds it, but
        can&apos;t tell whether the code does what it says. Activate only plugins you wrote or read.
      </p>
      {busy && <p className="mb-3 text-sm text-ash-300">{busy}</p>}
      {error && <p className="mb-3 text-sm text-ember-600">{error}</p>}
      {review && (
        <>
          {review.errors.length > 0 && (
            <div className="mb-4 rounded-lg border border-ember-600/50 p-3 text-sm">
              <p className="mb-1 text-ember-600">It can&apos;t be activated yet:</p>
              <ul className="list-disc pl-5 text-ash-300">
                {review.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {review.warnings.map((w) => (
            <p key={w} className="mb-2 text-xs text-molten-300">
              {w}
            </p>
          ))}
          {review.ok && (
            <p className="mb-4 text-sm text-ash-300">
              Version {review.version.from ? `${review.version.from} → ` : ''}
              {review.version.to}
            </p>
          )}

          {review.newPermissions.length > 0 && (
            <section className="mb-4">
              <h5 className="mb-2 text-sm text-ash-200">New permissions to approve</h5>
              {review.newPermissions.map((x) => (
                <label key={x} className="mb-1 flex items-start gap-2 text-sm text-ash-300">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ticked.has(x)}
                    onChange={(e) => {
                      const next = new Set(ticked)
                      if (e.target.checked) next.add(x)
                      else next.delete(x)
                      setTicked(next)
                    }}
                  />
                  <span>
                    {describePermission(x)} <code className="text-xs text-ash-500">{x}</code>
                  </span>
                </label>
              ))}
            </section>
          )}
          {review.removedPermissions.length > 0 && (
            <p className="mb-4 text-xs text-ash-400">
              No longer needed: {review.removedPermissions.map(describePermission).join('; ')}
            </p>
          )}

          <section className="mb-4">
            <h5 className="mb-2 text-sm text-ash-200">
              {review.files.length
                ? `Changes since ${review.version.from ? `version ${review.version.from}` : 'nothing was active'}`
                : 'No source changes'}
            </h5>
            {review.files.map((f) => (
              <div key={f.path} className="mb-1">
                <button
                  className="text-left text-xs text-ash-300 hover:text-molten-200"
                  onClick={() => setOpen(open === f.path ? null : f.path)}
                >
                  {f.change === 'added' ? '+' : f.change === 'removed' ? '−' : '~'} {f.path}
                </button>
                {open === f.path && (
                  <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-forge-950 p-2 text-[11px] leading-4 text-ash-300">
                    {f.diff ?? (f.change === 'removed' ? '(removed)' : '(too large to show)')}
                  </pre>
                )}
              </div>
            ))}
          </section>

          <section className="mb-4">
            <button className={secondary} onClick={runTests} disabled={!!busy || !review.ok}>
              Run tests
            </button>
            {tests && (
              <ul className="mt-2 text-xs">
                {tests.results.map((t) => (
                  <li key={t.name} className={t.ok ? 'text-ash-300' : 'text-ember-600'}>
                    {t.ok ? '✓' : '✕'} {t.name}
                    {t.error ? `: ${t.error}` : ''}
                  </li>
                ))}
                {tests.error && <li className="text-ember-600">{tests.error}</li>}
              </ul>
            )}
          </section>
        </>
      )}
      <div className="flex gap-2">
        <button
          className={primary}
          disabled={!review?.ok || !allTicked || !!busy}
          onClick={activate}
        >
          Activate {review?.version.to ?? ''}
        </button>
        <button className={secondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function Detail({
  p,
  onChange
}: {
  p: PluginStatus
  onChange: (s: PluginStatus) => void
}): React.JSX.Element {
  const [reviewing, setReviewing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (label: string, f: () => Promise<PluginStatus>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      onChange(await f())
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(null)
    }
  }

  if (reviewing)
    return (
      <Review
        p={p}
        onCancel={() => setReviewing(false)}
        onDone={(s) => {
          setReviewing(false)
          onChange(s)
        }}
      />
    )

  const pending = p.requested.filter((x) => !p.granted.includes(x))
  const writeTools = p.tools.filter((t) => t.effect === 'write')
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <h4 className="text-sm font-medium">{p.name}</h4>
        {p.active && <span className="text-xs text-ash-500">v{p.active.version}</span>}
        <Badge p={p} />
      </div>
      <p className="mb-1 text-sm text-ash-300">{p.description}</p>
      <p className="mb-4 truncate text-xs text-ash-500" title={p.dir}>
        Source: plugin/{p.id}
      </p>

      {p.sourceErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-ember-600/50 p-3 text-xs text-ash-300">
          <p className="mb-1 text-ember-600">Problems in the source</p>
          <ul className="list-disc pl-4">
            {p.sourceErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2">
        {p.sourceChanged && !p.sourceErrors.length && (
          <button className={primary} onClick={() => setReviewing(true)}>
            {p.active ? 'Review update' : 'Review and activate'}
          </button>
        )}
        {p.state === 'enabled' && (
          <button
            className={secondary}
            onClick={() => run('Disabling…', () => window.custard.plugins.disable(p.id))}
          >
            Disable
          </button>
        )}
        {p.state === 'disabled' && (
          <button
            className={secondary}
            onClick={() => run('Enabling…', () => window.custard.plugins.enable(p.id))}
          >
            Enable
          </button>
        )}
        {p.previous && (
          <button
            className={secondary}
            onClick={() => run('Rolling back…', () => window.custard.plugins.rollback(p.id))}
          >
            Roll back to {p.previous.version}
          </button>
        )}
        {p.active && (
          <button
            className={danger}
            onClick={() => run('Uninstalling…', () => window.custard.plugins.uninstall(p.id))}
          >
            Uninstall
          </button>
        )}
      </div>
      {busy && <p className="mb-3 text-sm text-ash-300">{busy}</p>}
      {error && <p className="mb-3 text-sm text-ember-600">{error}</p>}
      {p.secretsLocked && (
        <section className="mb-5 rounded-xl border border-ember-600/50 p-3" role="alert">
          <p className="text-sm text-ember-600">
            Custard can&apos;t read this plugin&apos;s saved secrets right now: the system&apos;s
            secure storage refused. They&apos;re kept as they are, and nothing can change them until
            they can be read.
          </p>
          <p className="mt-1 text-xs text-ash-500">
            Unlock your keyring or secure storage and restart Custard. Reset only if they can&apos;t
            be recovered: it deletes the account sign-in and secret settings.
          </p>
          <button
            className={`${danger} mt-2`}
            onClick={() => run('Resetting…', () => window.custard.plugins.resetSecrets(p.id))}
          >
            Reset saved secrets
          </button>
        </section>
      )}

      {p.auth && (
        <section className="mb-5">
          <h4 className="mb-1 text-sm font-medium">
            Account{' '}
            <span className={p.auth.connected ? 'text-molten-300' : 'text-ash-500'}>
              · {p.auth.connected ? 'connected' : 'not connected'}
            </span>
          </h4>
          <p className="mb-2 text-xs text-ash-500">
            Custard signs in and keeps the tokens in secure storage. The plugin never sees them.
          </p>
          {p.auth.connected ? (
            <button
              className={secondary}
              onClick={() => run('Disconnecting…', () => window.custard.plugins.disconnect(p.id))}
            >
              Disconnect
            </button>
          ) : (
            <button
              className={primary}
              disabled={p.state !== 'enabled'}
              onClick={() =>
                run('Waiting for you to approve access in the browser…', () =>
                  window.custard.plugins.connect(p.id)
                )
              }
            >
              Connect
            </button>
          )}
          {p.state !== 'enabled' && !p.auth.connected && (
            <p className="mt-1 text-xs text-ash-500">Activate the plugin first.</p>
          )}
        </section>
      )}

      <ConfigForm key={p.id} p={p} onSaved={onChange} />
      {p.active && <PluginMemory p={p} />}

      {writeTools.length > 0 && (
        <section className="mb-5">
          <h4 className="mb-1 text-sm font-medium">Actions</h4>
          <p className="mb-2 text-xs text-ash-500">
            These change something outside Custard. Being installed doesn&apos;t let the assistant
            run them on its own: it asks you each time unless you turn that off here.
          </p>
          {writeTools.map((t) => (
            <label key={t.name} className="mb-1 flex items-center gap-2 text-sm text-ash-300">
              <input
                type="checkbox"
                checked={t.askEveryTime}
                onChange={(e) =>
                  run('Saving…', () =>
                    window.custard.plugins.setAskEveryTime(p.id, t.name, e.target.checked)
                  )
                }
              />
              Ask before <code className="text-xs">{t.fullName}</code>
            </label>
          ))}
        </section>
      )}

      <section className="mb-5">
        <h4 className="mb-1 text-sm font-medium">Permissions</h4>
        {p.granted.length ? (
          <ul className="list-disc pl-5 text-sm text-ash-300">
            {p.granted.map((x) => (
              <li key={x}>{describePermission(x)}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ash-500">None granted yet.</p>
        )}
        {p.active && pending.length > 0 && (
          <p className="mt-2 text-xs text-molten-300">
            The source asks for more: {pending.map(describePermission).join('; ')}. Review the
            update to approve.
          </p>
        )}
      </section>

      <section>
        <h4 className="mb-1 text-sm font-medium">
          Health{' '}
          <span className="text-xs text-ash-500">{p.running ? '· running' : '· not running'}</span>
        </h4>
        {p.errors.length === 0 && p.log.length === 0 && (
          <p className="text-sm text-ash-500">No recent errors.</p>
        )}
        <ul className="text-xs text-ash-400">
          {p.errors
            .slice(-5)
            .reverse()
            .map((e) => (
              <li key={e.at + e.message} className="mb-1">
                <span className="text-ash-500">{when(e.at)}</span> {e.message}
              </li>
            ))}
        </ul>
        {p.log.length > 0 && (
          <details className="mt-2 text-xs text-ash-400">
            <summary className="cursor-pointer">Recent log</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
              {p.log.join('\n')}
            </pre>
          </details>
        )}
      </section>
    </div>
  )
}

function PluginsTab(): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((list: PluginStatus[]) => {
    setPlugins(list)
    setSelected((s) => s ?? list[0]?.id ?? null)
  }, [])
  const load = useCallback(
    () =>
      window.custard.plugins
        .list()
        .then(apply)
        .catch((e) => setError(cleanError(e))),
    [apply]
  )
  useEffect(() => {
    window.custard.plugins
      .list()
      .then(apply)
      .catch((e) => setError(cleanError(e)))
  }, [apply])

  const replace = (s: PluginStatus): void =>
    setPlugins((list) => (list ?? []).map((x) => (x.id === s.id ? s : x)))
  const p = plugins?.find((x) => x.id === selected)

  return (
    <div className="flex min-h-[420px] gap-5">
      <div className="w-44 shrink-0 border-r border-forge-700 pr-3">
        {plugins?.length === 0 && (
          <p className="text-sm text-ash-500">
            No plugins yet. Create one in Code mode under Plugins.
          </p>
        )}
        {plugins?.map((x) => (
          <button
            key={x.id}
            onClick={() => setSelected(x.id)}
            className={`mb-1 block w-full rounded-lg px-2 py-1.5 text-left ${
              x.id === selected ? 'bg-forge-800' : 'hover:bg-forge-800/60'
            }`}
          >
            <span className="block truncate text-sm text-ash-100">{x.name}</span>
            <Badge p={x} />
          </button>
        ))}
        <button onClick={load} className="mt-2 text-xs text-ash-500 hover:text-molten-200">
          Refresh
        </button>
      </div>
      <div className="min-w-0 flex-1">
        {error && <p className="text-sm text-ember-600">{error}</p>}
        {p ? (
          <Detail key={p.id} p={p} onChange={replace} />
        ) : plugins === null ? (
          <p className="text-sm text-ash-500">Loading…</p>
        ) : null}
      </div>
    </div>
  )
}

export default PluginsTab
