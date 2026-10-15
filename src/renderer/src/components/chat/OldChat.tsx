import { OLD_CHAT_TEXT, type OldChat } from '../../../../shared/neutralChat'
import { danger } from '../settings/ui'

// A chat this Custard can't open (saved by an earlier one, by a newer one,
// or a file that can't be read): its title, why, and Delete. None of its
// messages are read, and nothing is sent from it.
export default function OldChatView({
  chat,
  onDelete
}: {
  chat: OldChat
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label="Old chat"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="text-xs tracking-[0.2em] text-ash-500 uppercase">Old format</div>
      <h1 className="max-w-xl text-2xl font-semibold break-words text-molten-200">{chat.title}</h1>
      <p className="max-w-md text-sm text-ash-400">{OLD_CHAT_TEXT[chat.old]}</p>
      <button onClick={onDelete} className={danger}>
        Delete
      </button>
    </div>
  )
}
