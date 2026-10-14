import { useEffect, useRef, useState } from 'react'
import type { ChatSettings, ModelAvailability } from '../../../../shared/chat'
import { ArrowUpIcon, PaperclipIcon, StopIcon } from '../icons'
import type { DraftAttachment } from '../../../../shared/attachments'
import { DraftFiles } from './Attachments'
import { DraftReferences, ReferenceButton } from './References'
import type { ChatLink } from '../../../../shared/chat'
import ModelPicker from './ModelPicker'

type Props = {
  busy: boolean
  placeholder: string
  settings: ChatSettings
  onSettings: (s: ChatSettings) => void
  // Which models can be used now (null until known).
  availability: ModelAvailability[] | null
  // Bumped to open the model picker (Pick a different model).
  pickerSignal?: number
  // The chat's model can't be used now: nothing can be sent.
  blocked?: boolean
  onSend: (text: string) => void
  onStop: () => void
  draft: string
  setDraft: (text: string) => void
  // The chat's context and cost meter, beside the model pills.
  meter?: React.ReactNode
  // Chat and Design only: files to send with the message.
  files?: {
    items: DraftAttachment[]
    errors: { name: string; error: string }[]
    adding: boolean
    onPick: () => void
    onAdd: (files: File[]) => void
    onRemove: (id: string) => void
    onDismiss: () => void
  }
  // Earlier chats whose summary notes go with the message.
  references?: {
    current: string | null
    items: ChatLink[]
    onAdd: (c: ChatLink) => void
    onRemove: (id: string) => void
  }
}

const chip =
  'cursor-pointer appearance-none rounded-full border border-forge-700 bg-forge-900 px-3 py-1 text-xs text-ash-400 outline-none transition-colors hover:border-forge-600 hover:text-ash-100'

function Composer(props: Props): React.JSX.Element {
  const { busy, placeholder, settings, onSettings, onSend, onStop, draft, setDraft, files } = props
  const { meter, references, availability, pickerSignal, blocked } = props
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const hasFiles = !!files?.items.length
  const canSend = !busy && !blocked && !files?.adding && (!!draft.trim() || hasFiles)
  const input = useRef<HTMLTextAreaElement>(null)
  const submit = (): void => {
    if (canSend) onSend(draft)
  }

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  return (
    <div
      onDragOver={(e) => {
        if (!files || busy || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!files || busy || !e.dataTransfer.files.length) return
        e.preventDefault()
        files.onAdd([...e.dataTransfer.files])
      }}
      className={`rounded-3xl border bg-forge-850/90 p-3 backdrop-blur transition-all ${
        dragging
          ? 'border-molten-400 shadow-[0_0_40px_rgb(var(--glow)/0.25)]'
          : focused
            ? 'border-molten-500/50 shadow-[0_0_40px_rgb(var(--glow-deep)/0.12)]'
            : 'border-forge-700 shadow-[0_10px_40px_rgb(0_0_0/0.4)]'
      }`}
    >
      {files && (
        <DraftFiles
          files={files.items}
          errors={files.errors}
          onRemove={files.onRemove}
          onDismiss={files.onDismiss}
          disabled={busy}
        />
      )}
      {references && (
        <DraftReferences items={references.items} onRemove={references.onRemove} disabled={busy} />
      )}
      <textarea
        ref={input}
        onPaste={(e) => {
          // Pasted files (a screenshot, files copied in the file manager)
          // are attached; pasted text goes in as usual.
          if (!files || busy || !e.clipboardData.files.length) return
          e.preventDefault()
          files.onAdd([...e.clipboardData.files])
        }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={1}
        autoFocus
        placeholder={placeholder}
        className="block max-h-60 min-h-[44px] w-full resize-none bg-transparent px-2 pt-1.5 text-[15px] text-ash-100 outline-none placeholder:text-ash-500"
      />
      <div className="mt-2 flex items-center gap-2">
        {files && (
          <button
            onClick={files.onPick}
            disabled={busy || files.adding}
            title="Attach images, PDFs or text files (or paste or drop them here)"
            aria-label="Attach files"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-forge-700 text-base text-ash-400 transition-colors hover:border-molten-500/50 hover:text-molten-200 disabled:opacity-40"
          >
            <PaperclipIcon />
          </button>
        )}
        {references && (
          <ReferenceButton
            current={references.current}
            picked={references.items}
            onAdd={references.onAdd}
            disabled={busy}
          />
        )}
        <ModelPicker
          className={chip}
          settings={settings}
          availability={availability}
          onPick={onSettings}
          openSignal={pickerSignal}
        />
        {meter}
        <div className="ml-auto">
          {busy ? (
            <button
              onClick={onStop}
              title="Stop"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-forge-600 text-ash-300 hover:border-ember-600 hover:text-molten-200"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title="Send"
              className="molten-fill flex h-9 w-9 items-center justify-center rounded-full text-lg text-forge-950 transition-opacity disabled:opacity-30"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default Composer
