import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allProfiles,
  builtInProfiles,
  NoProfileError,
  profileOf,
  requireProfile,
  setProfiles,
  type ModelProfile
} from '../shared/models'
import { chatModels, chatSettingsOf, defaultChatSettings, isChatModel } from '../shared/chat'
import { providerIds, providers } from '../shared/providers'
import { loadModelRegistry, registeredProfiles } from './modelRegistry'
import { adapterFor, adapterForModel } from './adapters/registry'
import { availabilityFrom } from './adapters/checks'
import { continueChat } from './continue'
import { SUMMARY_MODELS } from './memory/summarize'
import { HANDOFF_MODELS } from './handoff'
import type { Conversation } from '../shared/chat'

// Phase A3: main owns the list of profiles at run time, and a model id with
// no profile is never sent anywhere (no quiet fallback to Opus 5.5).

const UNKNOWN = 'deepseek-v5-preview'
afterEach(() => {
  loadModelRegistry()
})

describe('the model registry', () => {
  it('holds the built-in profiles, in picker order', () => {
    expect(loadModelRegistry()).toEqual(builtInProfiles)
    expect(registeredProfiles()).toEqual(builtInProfiles)
    expect(chatModels().map((m) => m.id)).toEqual(builtInProfiles.map((m) => m.id))
  })

  it('every lookup follows the registry (what A4 adds a source to)', () => {
    const extra: ModelProfile = { ...builtInProfiles[6], id: UNKNOWN, label: 'V5 Preview' }
    loadModelRegistry(() => [extra])
    expect(allProfiles()).toHaveLength(builtInProfiles.length + 1)
    expect(profileOf(UNKNOWN)?.label).toBe('V5 Preview')
    expect(isChatModel(UNKNOWN)).toBe(true)
    // A profile that is gone is gone everywhere at once.
    setProfiles(builtInProfiles.filter((m) => m.id !== 'deepseek-flash'))
    expect(isChatModel('deepseek-flash')).toBe(false)
    expect(chatModels().some((m) => m.id === 'deepseek-flash')).toBe(false)
  })

  // ChatModel is a string now, so TypeScript no longer checks that a model
  // named in the code exists. This does instead.
  it('every model id the app names resolves to a profile', () => {
    expect(isChatModel(defaultChatSettings.model)).toBe(true)
    for (const p of providerIds) {
      expect(profileOf(providers[p].summaryModel)?.provider, p).toBe(p)
      expect(profileOf(SUMMARY_MODELS[p])?.provider, p).toBe(p)
      expect(profileOf(HANDOFF_MODELS[p])?.provider, p).toBe(p)
    }
    // Every quoted model id in the app's own code (not tests or comments).
    const ids = new Set<string>()
    const walk = (dir: string): void => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name)
        if (f.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name)) {
          const code = fs
            .readFileSync(p, 'utf8')
            .split('\n')
            .filter((l) => !l.trim().startsWith('//'))
            .join('\n')
          for (const m of code.matchAll(/['"`]((?:claude|gpt|deepseek)-[a-z0-9.-]+)['"`]/g))
            ids.add(m[1])
        }
      }
    }
    walk(path.join(__dirname, '..'))
    // Search tool versions, an image rule and a key file, not chat models;
    // Design's image models are a list of their own (design/images).
    const notModels = ['claude-20260209', 'claude-20250305', 'claude-small', 'deepseek-key.bin']
    const named = [...ids].filter((id) => !notModels.includes(id) && !id.startsWith('gpt-image-'))
    expect(named.length).toBeGreaterThan(5)
    for (const id of named) expect(profileOf(id), id).toBeDefined()
  })
})

describe('a model id with no profile', () => {
  it('fails loudly where a provider would be picked', () => {
    expect(() => requireProfile(UNKNOWN)).toThrow(NoProfileError)
    expect(() => requireProfile(UNKNOWN)).toThrow(
      `${UNKNOWN} can't be used right now: its profile is missing. Pick a different model.`
    )
    // It used to go to Claude's adapter.
    expect(() => adapterForModel(UNKNOWN)).toThrow(NoProfileError)
    expect(adapterForModel('gpt-6-astra')).toBe(adapterFor('openai'))
  })

  it('never reaches Claude: the adapter refuses it before any request', async () => {
    // It used to be sent as Opus 5.5. No address is set up: a request would fail.
    await expect(
      adapterFor('claude').streamMessage({ model: UNKNOWN, apiKey: 'sk-ant-test' } as never)
    ).rejects.toThrow(NoProfileError)
  })

  it('stays the chat’s model, and the chat says it can’t be used', () => {
    const c = { id: 'c', mode: 'chat', messages: [], model: UNKNOWN } as unknown as Conversation
    expect(chatSettingsOf(c, defaultChatSettings).model).toBe(UNKNOWN)
    // The same for a default model with no profile: a new chat starts on it.
    expect(chatSettingsOf(null, { model: UNKNOWN, effort: 'medium' }).model).toBe(UNKNOWN)
    // Availability covers only models with a profile; ChatView marks the rest
    // no-profile.
    expect(
      availabilityFrom(
        () => true,
        () => null
      ).some((a) => a.id === UNKNOWN)
    ).toBe(false)
  })

  it('continuing a long chat asks no provider for the summary', async () => {
    const original = {
      id: 'o',
      mode: 'chat',
      title: 'Long',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', content: 'hi' }],
      context: { model: UNKNOWN, tokens: 1, budget: 2, counted: false, warn: true }
    } as unknown as Conversation
    const created: Conversation[] = []
    const r = await continueChat(
      {
        load: () => original,
        create: (mode, title) => {
          const c = { id: 'n', mode, title, messages: [] } as unknown as Conversation
          created.push(c)
          return c
        },
        save: () => {},
        summarizer: () => 'its profile is missing'
      },
      'o'
    )
    expect(r).toEqual({ ok: false, error: 'its profile is missing', canSkipSummary: true })
    expect(created).toHaveLength(0)
  })
})
