import { useEffect, useState } from 'react'
import type { Artifact } from '../../../../shared/design'

// A chat's Design outputs, kept current from the main process's events.
// `latest` is the output that last changed (with a count that moves on
// every change), so the workspace can bring it to the front.
export type Latest = { id: string; seq: number } | null
export function useOutputs(chat: string | null): { outputs: Artifact[]; latest: Latest } {
  const [state, setState] = useState<{
    chat: string | null
    outputs: Artifact[]
    latest: Latest
  }>({ chat: null, outputs: [], latest: null })

  useEffect(() => {
    if (!chat) return
    let gone = false
    void window.custard.design.subscribe()
    void window.custard.design.list(chat).then(async (list) => {
      const all = await Promise.all(list.map((s) => window.custard.design.get(chat, s.id)))
      if (!gone)
        setState({
          chat,
          outputs: all.filter((a): a is Artifact => !!a).sort((a, b) => a.createdAt - b.createdAt),
          latest: null
        })
    })
    const off = window.custard.design.onEvent((e) => {
      if (e.type !== 'artifact' || e.conversationId !== chat) return
      setState((s) => {
        const outputs = s.chat === chat ? s.outputs : []
        const at = outputs.findIndex((a) => a.id === e.artifact.id)
        return {
          chat,
          outputs:
            at < 0 ? [...outputs, e.artifact] : outputs.map((a, i) => (i === at ? e.artifact : a)),
          latest: { id: e.artifact.id, seq: (s.latest?.seq ?? 0) + 1 }
        }
      })
    })
    return () => {
      gone = true
      off()
    }
  }, [chat])

  return state.chat === chat && chat ? state : { outputs: [], latest: null }
}
