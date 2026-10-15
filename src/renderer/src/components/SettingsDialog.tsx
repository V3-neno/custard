import { useCallback, useEffect, useRef, useState } from 'react'
import {
  providerIds,
  providerInfo,
  providers,
  providerNames,
  type Provider
} from '../../../shared/providers'
import { MEMORY_NOTE, type VaultInfo } from '../../../shared/vault'
import type { MemorySettings } from '../../../shared/memory'
import { profileOf, shownLevel } from '../../../shared/models'
import {
  chatModels,
  isChatModel,
  isEffort,
  type ChatSettings,
  type UsageMonth
} from '../../../shared/chat'
import type { Capability, ModelCheck } from '../../../shared/adapter'
import { formatCost } from '../../../shared/pricing'

import DesignTab from './settings/DesignTab'
import CapabilitiesTab from './settings/CapabilitiesTab'
import EditableFolders from './settings/EditableFolders'
import Automations from './settings/Automations'
import ModelsFile from './settings/ModelsFile'
import { cleanError, primary, secondary } from './settings/ui'
import Select from './ui/Select'
import PillGroup from './ui/PillGroup'

type Props = {
  onClose: () => void
  onChanged: () => void
  // Capabilities → Start building (see App).
  onBuild: (provider: Provider, capability: Capability) => Promise<void>
}
type Tab = 'general' | 'design' | 'capabilities'

const checkedAt = (t: number): string =>
  new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// What the last check found, in a sentence.
function checkLine(provider: Provider, c: ModelCheck): { text: string; ok: boolean } {
  const name = providerNames[provider]
  const at = checkedAt(c.checkedAt)
  if (c.result === 'ok') return { text: `Checked ${at}: the key works.`, ok: true }
  if (c.result === 'auth')
    return { text: `Checked ${at}: ${name} rejected this key. Paste a new one above.`, ok: false }
  return {
    text: `Couldn't check at ${at}. ${c.message ?? ''} Your saved key wasn't changed.`,
    ok: false
  }
}

function KeySection({
  provider,
  onChanged
}: {
  provider: Provider
  onChanged: () => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The last check with the provider (Save or Refresh only), and whether one
  // is running.
  const [check, setCheck] = useState<ModelCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const name = providerNames[provider]

  const refresh = useCallback(() => window.custard.apiKey.has(provider).then(setHasKey), [provider])
  useEffect(() => {
    refresh()
    window.custard.models.lastCheck(provider).then(setCheck)
  }, [refresh, provider])

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      setCheck(await window.custard.models.check(provider))
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setChecking(false)
    }
  }

  const save = async (): Promise<void> => {
    try {
      await window.custard.apiKey.set(provider, key)
      setKey('')
      setError(null)
      refresh()
      onChanged()
    } catch (e) {
      setError(cleanError(e))
      return
    }
    await runCheck()
  }

  const clear = async (): Promise<void> => {
    await window.custard.apiKey.clear(provider)
    setCheck(null)
    refresh()
    onChanged()
  }

  const line = check && checkLine(provider, check)
  const known = check?.models.filter((m) => m.source === 'profile') ?? []
  const unsupported = check?.models.filter((m) => m.source === 'discovered') ?? []
  return (
    <section className="mb-6" data-provider-key={provider}>
      <h3 className="mb-1 text-sm font-medium">
        {name} API key {hasKey && <span className="text-molten-300">· saved</span>}
      </h3>
      <p className="mb-3 text-sm text-ash-300">Get one at {providers[provider].keyWhere}.</p>
      <div className="flex gap-2">
        <input
          type="password"
          aria-label={`${name} API key`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && save()}
          placeholder={
            hasKey ? 'Paste a new key to replace it' : providers[provider].keyPlaceholder
          }
          className="flex-1 rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm outline-none focus:border-molten-500/60"
        />
        <button onClick={save} disabled={!key.trim() || checking} className={primary}>
          Save
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
      {hasKey && (
        <div className="mt-2 flex items-start gap-3 text-xs" aria-live="polite">
          <p
            className={`flex-1 ${checking ? 'text-ash-400' : line ? (line.ok ? 'text-molten-300' : 'text-ember-600') : 'text-ash-400'}`}
            data-check-status
          >
            {checking
              ? `Checking the key with ${name}…`
              : (line?.text ??
                `Not checked yet. Refresh asks ${name} which models this key can use.`)}
          </p>
          <button
            onClick={runCheck}
            disabled={checking}
            className="shrink-0 whitespace-nowrap text-ash-400 hover:text-molten-200 disabled:opacity-40"
            title={`Check the key with ${name} and see which models it can use`}
          >
            Refresh
          </button>
          <button
            onClick={clear}
            className="shrink-0 whitespace-nowrap text-ash-500 hover:text-ember-600"
          >
            Remove key
          </button>
        </div>
      )}
      {hasKey && !checking && check?.result === 'ok' && (
        <div className="mt-2 text-xs text-ash-400" data-check-models>
          <p className="text-ash-300">Available models</p>
          <ul className="mt-0.5">
            {known.map((m) => (
              <li key={m.id} data-model-row={m.id} data-available={m.available}>
                <span className={m.available ? 'text-ash-200' : 'text-ash-500 line-through'}>
                  {m.label}
                </span>
                {!m.available && (
                  <span className="text-ash-500"> · Your key can&apos;t use this model</span>
                )}
              </li>
            ))}
          </ul>
          {providerInfo(provider).effortNote && (
            <p className="mt-1 text-ash-500" data-effort-note>
              {providerInfo(provider).effortNote}
            </p>
          )}
          {unsupported.length > 0 && (
            <div className="mt-2" data-unsupported>
              <p className="text-ash-300">
                Not yet supported: {unsupported.map((m) => m.label).join(', ')}
              </p>
              <p className="mt-0.5 text-ash-500">
                {name} offers these, but Custard has no prices, context limits or file rules for
                them yet, so they can&apos;t be picked. They&apos;re shown so you know they exist.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// The model new chats start on. Each chat keeps the model it was started
// with (or switched to); changing this changes no existing chat.
function DefaultModelSection({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [s, setS] = useState<ChatSettings | null>(null)
  const modelBox = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    window.custard.settings.get().then(setS)
  }, [])
  if (!s) return <section className="mb-6" />
  // A stored default with no profile is kept, not replaced: Settings and
  // every new chat say so until another model is picked.
  const known = isChatModel(s.model)
  // The default model's effort levels, labelled as Settings always has
  // them (see settingsLabel in shared/models.ts).
  const levels = profileOf(s.model)?.effort ?? null
  const save = (next: ChatSettings): void => {
    setS(next)
    window.custard.settings.set(next).then(onChanged)
  }
  return (
    <section className="mb-6" data-default-model>
      <h3 className="mb-1 text-sm font-medium">Default model</h3>
      <p className="mb-3 text-sm text-ash-300">
        New chats start on it. Each chat keeps its own model; pick another under the message box.
      </p>
      {!known && (
        <p
          role="status"
          data-default-model-notice="no-profile"
          className="mb-3 rounded-2xl border border-forge-700 bg-forge-900 px-4 py-2.5 text-sm text-ash-300"
        >
          {s.model} can&apos;t be used right now. Its profile is missing, so new chats can&apos;t be
          sent until you pick a different model.{' '}
          <button
            onClick={() => modelBox.current?.focus()}
            className="text-molten-300 hover:underline"
          >
            Pick a different model
          </button>
        </p>
      )}
      <Select
        ref={modelBox}
        title="Default model"
        aria-label="Default model"
        className="w-full"
        value={s.model}
        onChange={(e) => {
          const id = e.target.value
          if (!isChatModel(id)) return
          save({ model: id, effort: shownLevel(profileOf(id)?.effort ?? null, s.effort) })
        }}
      >
        {!known && (
          <option value={s.model} disabled>
            {s.model} (no profile)
          </option>
        )}
        {providerIds.map((p) => (
          <optgroup key={p} label={providerNames[p]}>
            {chatModels()
              .filter((m) => m.provider === p)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      {levels && (
        <p className="mt-3 mb-1 text-xs text-ash-400" aria-hidden>
          Default effort
        </p>
      )}
      {levels && (
        <PillGroup
          label="Default effort"
          options={levels.levels.map((l) => ({ value: l.value, label: l.settingsLabel }))}
          value={shownLevel(levels, s.effort)}
          onChange={(e) => isEffort(e) && save({ ...s, effort: e })}
        />
      )}
    </section>
  )
}

// A monthly budget for model calls. Custard warns under the message box from
// 80% of it and when it is passed; it never stops a chat.
function SpendingSection(): React.JSX.Element {
  const [month, setMonth] = useState<UsageMonth | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    window.custard.usage.month().then((m) => {
      setMonth(m)
      setDraft(m.budget === null ? '' : String(m.budget))
    })
  }, [])
  const save = async (): Promise<void> => {
    const text = draft.trim().replace(/^\$/, '')
    const dollars = text === '' ? null : Number(text)
    if (dollars !== null && !(Number.isFinite(dollars) && dollars > 0 && dollars <= 1_000_000)) {
      setError('Enter an amount in dollars, like 20, or leave it empty for no budget.')
      return
    }
    setError(null)
    const m = await window.custard.usage.setBudget(dollars)
    setMonth(m)
    setDraft(m.budget === null ? '' : String(m.budget))
  }
  const saved = month?.budget === null ? '' : String(month?.budget ?? '')
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">Spending</h3>
      <p className="mb-3 text-sm text-ash-300">
        {month
          ? `This month so far: about ${formatCost(month.cost)} across ${month.calls} model ${month.calls === 1 ? 'call' : 'calls'}${month.budget ? `, of your ${formatCost(month.budget)} budget` : ''}.`
          : 'This month so far: …'}{' '}
        Custard estimates it from each provider&apos;s published prices, including its own summaries
        and automations. Image generation isn&apos;t counted, and your provider&apos;s bill is what
        counts.
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-ash-400">$</span>
        <input
          inputMode="decimal"
          aria-label="Monthly budget in dollars"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="No budget"
          className="w-32 rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm outline-none focus:border-molten-500/60"
        />
        <span className="text-sm text-ash-400">a month</span>
        <button onClick={save} disabled={draft.trim() === saved} className={primary}>
          Save
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-ember-600">{error}</p>}
      <p className="mt-2 text-xs text-ash-400">
        From 80% of the budget, and when it is passed, a line under the message box says so. Custard
        never stops a chat because of it.
      </p>
    </section>
  )
}

function MemorySection(): React.JSX.Element {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  useEffect(() => {
    window.custard.memory.getSettings().then(setSettings)
  }, [])
  return (
    <section className="mb-6">
      <h3 className="mb-1 text-sm font-medium">Memory</h3>
      <label className="flex items-start gap-2 text-sm text-ash-300">
        <input
          type="checkbox"
          className="mt-1"
          aria-label="Remember automatically"
          checked={settings?.auto ?? true}
          disabled={settings === null}
          onChange={(e) => {
            const next = { ...settings!, auto: e.target.checked }
            setSettings(next)
            window.custard.memory.setSettings(next)
          }}
        />
        <span>
          Remember automatically. After a chat where something happened (plugin actions, changes,
          tests, failures) or that went on for a while, Custard makes one short summary with your
          provider&apos;s cheapest model and saves it as a new note in Custard/Captures in your
          vault. Small talk and plain questions aren&apos;t saved, and neither are keys, passwords,
          note contents or web pages. Each chat also gets one summary note in Custard/Chats (what it
          was for, where it stands, what was decided), which Custard keeps up to date as the chat
          goes on and stops updating once you change it.
        </span>
      </label>
      <p className="mt-2 text-xs text-ash-400">
        Attached files are different from what you type. Custard remembers only how many files of
        which types a chat had, never their names or contents. Text you type or paste into a message
        is ordinary chat content and can be saved, even if you copied it from a file.
      </p>
      <p className="mt-2 text-xs text-ash-400">
        {settings && !settings.auto
          ? "Off: nothing new is saved, and waiting summaries and chat notes are cancelled. Notes already in your vault stay until you edit them, and chats from while it was off aren't saved later."
          : "To keep one chat out, start it as a Temporary chat from the top bar; Forget in History deletes a chat's notes, its chat note included. You can also turn it off for a plugin with Manage in Plugins mode. Edit or delete anything in your vault; what you delete is not added back."}
      </p>
    </section>
  )
}

function SettingsDialog({ onClose, onChanged, onBuild }: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('general')
  // Bumped by Reload of the models file, so the model lists read it again.
  const [modelsVersion, setModelsVersion] = useState(0)
  const [vault, setVault] = useState<VaultInfo>(null)

  useEffect(() => {
    window.custard.vault.get().then(setVault)
  }, [])

  const [vaultError, setVaultError] = useState<string | null>(null)
  const pickVault = async (): Promise<void> => setVault(await window.custard.vault.pick())
  const createStarter = async (): Promise<void> => {
    try {
      setVaultError(null)
      setVault(await window.custard.vault.createStarter())
    } catch (e) {
      setVaultError(cleanError(e))
    }
  }
  const [added, setAdded] = useState<string | null>(null)
  const addSkills = async (): Promise<void> => {
    try {
      const r = await window.custard.vault.addStarterSkills()
      setVault(r.vault)
      setAdded(
        r.added.length
          ? `Added ${r.added.join(', ')}`
          : 'Your vault already has every starter skill and Custard reference note.'
      )
    } catch (e) {
      setVaultError(cleanError(e))
    }
  }
  const clearVault = async (): Promise<void> => {
    await window.custard.vault.clear()
    setVault(null)
  }

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className={`max-h-[90vh] overflow-y-auto rounded-3xl border border-forge-700 bg-forge-850 p-6 ${tab === 'capabilities' ? 'w-[760px] max-w-[95vw]' : 'w-[480px]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-4">
          <h2 className="text-base font-semibold">Settings</h2>
          <div
            className="flex gap-1 rounded-full border border-forge-700 p-0.5 text-sm"
            role="tablist"
          >
            {(['general', 'design', 'capabilities'] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-full px-3 py-1 ${tab === t ? 'bg-forge-700 text-ash-100' : 'text-ash-400 hover:text-ash-100'}`}
              >
                {t === 'general' ? 'General' : t === 'design' ? 'Design' : 'Capabilities'}
              </button>
            ))}
          </div>
        </div>

        {tab === 'design' ? (
          <DesignTab />
        ) : tab === 'capabilities' ? (
          <CapabilitiesTab onBuild={onBuild} />
        ) : (
          <>
            <p className="mb-5 -mt-1 text-sm text-ash-400">
              Keys are encrypted with Windows secure storage and stay on this computer. Pick a model
              from any provider under the message box.
            </p>
            <DefaultModelSection key={modelsVersion} onChanged={onChanged} />
            <ModelsFile
              onReloaded={() => {
                setModelsVersion((n) => n + 1)
                onChanged()
              }}
            />
            {providerIds.map((p) => (
              <KeySection key={p} provider={p} onChanged={onChanged} />
            ))}
            <SpendingSection />

            <section>
              <h3 className="mb-1 text-sm font-medium">
                Obsidian vault {vault && <span className="text-molten-300">· connected</span>}
              </h3>
              <p className="mb-3 text-sm text-ash-300">
                The brain behind Custard. The model can search and read your notes and create new
                ones (you approve each). It changes existing notes only in the folders you allow
                below, and never overwrites a whole note or deletes anything. It keeps a memory of
                you in <code className="text-molten-200">{MEMORY_NOTE}</code>.
              </p>
              {vault ? (
                <>
                  <div className="truncate rounded-lg border border-forge-700 bg-forge-900 px-3 py-2 text-sm">
                    {vault.path}
                  </div>
                  <p className="mt-2 text-xs text-ash-500">
                    {vault.skills.length
                      ? `Skills: ${vault.skills.join(', ')}`
                      : 'No skills yet. Add them in Custard/Skills.'}
                  </p>
                  {!vault.isObsidian && (
                    <p className="mt-2 text-xs text-molten-300">
                      This folder has no .obsidian folder, so it may not be an Obsidian vault. It
                      still works as a notes folder.
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={pickVault} className={secondary}>
                      Change folder
                    </button>
                    <button
                      onClick={addSkills}
                      className={secondary}
                      title="Copies starter skills and the Custard reference notes (Resources) you don't have yet. Nothing is overwritten."
                    >
                      Add missing starter skills and notes
                    </button>
                    <button
                      onClick={clearVault}
                      className="text-xs text-ash-500 hover:text-ember-600"
                    >
                      Disconnect
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <button onClick={createStarter} className={primary}>
                    Create starter vault
                  </button>
                  <button onClick={pickVault} className={secondary}>
                    Use an existing vault
                  </button>
                </div>
              )}
              {vault && <EditableFolders />}
              {vault && <Automations />}
              {added && <p className="mt-2 text-xs text-ash-400">{added}</p>}
              {vaultError && <p className="mt-2 text-sm text-ember-600">{vaultError}</p>}
            </section>
            <div className="mt-6">
              <MemorySection />
            </div>
          </>
        )}

        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className={secondary}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsDialog
