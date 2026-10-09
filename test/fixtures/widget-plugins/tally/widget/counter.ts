import { defineWidget, type WidgetContext } from 'custard-plugin-sdk/widget'

// A list-style widget: a label, the count and its recent additions, one
// button. Everything it shows comes from its own plugin's tools.

let els: {
  label: HTMLElement
  count: HTMLElement
  recent: HTMLElement
  status: HTMLElement
  add: HTMLButtonElement
}
let busy = false

const labelOf = (input: unknown): string => {
  const l = (input as { label?: unknown } | null)?.label
  return typeof l === 'string' && l ? l : 'Tally'
}

async function load(ctx: WidgetContext): Promise<void> {
  const r = await ctx.call('count')
  if (r.status !== 'completed') {
    els.status.textContent = r.content
    return
  }
  const d = r.data as { count?: unknown; recent?: unknown } | undefined
  els.count.textContent = String(typeof d?.count === 'number' ? d.count : '?')
  els.recent.textContent =
    Array.isArray(d?.recent) && d.recent.length
      ? `recent: +${d.recent.join(', +')}`
      : 'nothing added yet'
}

export default defineWidget({
  mount(root, ctx) {
    root.innerHTML = `
      <style>
        #widget-root { font: 13px var(--custard-font, sans-serif); color: var(--custard-text, #eee); padding: 8px 14px; display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; }
        .label { color: var(--custard-text-muted, #aaa); font-size: 12px; }
        .count { font-size: 28px; font-weight: 600; color: var(--custard-accent-strong, #fc6); }
        .recent, .status { grid-column: 1 / -1; font-size: 11px; color: var(--custard-text-faint, #888); }
        button { grid-row: 1 / span 2; grid-column: 2; border-radius: 999px; border: 1px solid var(--custard-border, #444); background: transparent; color: var(--custard-text, #eee); padding: 6px 14px; cursor: pointer; }
        button:disabled { opacity: .4; }
      </style>
      <div class="label"></div>
      <button class="add">+1</button>
      <div class="count">…</div>
      <div class="recent"></div>
      <div class="status" role="status"></div>`
    els = {
      label: root.querySelector('.label')!,
      count: root.querySelector('.count')!,
      recent: root.querySelector('.recent')!,
      status: root.querySelector('.status')!,
      add: root.querySelector('.add')!
    }
    els.label.textContent = labelOf(ctx.input)
    els.add.addEventListener('click', async () => {
      if (busy) return
      busy = true
      els.add.disabled = true
      els.status.textContent = 'Adding…'
      const r = await ctx.call('add', { amount: 1 })
      els.status.textContent =
        r.status === 'completed'
          ? r.content
          : r.status === 'unknown'
            ? `Not sure it was added: ${r.content}`
            : r.content
      busy = false
      els.add.disabled = false
      if (r.status === 'completed') await load(ctx)
    })
    // Asks for the height its content needs; the host clamps it.
    new ResizeObserver(() => ctx.setHeight(root.scrollHeight)).observe(root)
    if (ctx.visible) void load(ctx)
  },
  update(input) {
    els.label.textContent = labelOf(input)
  },
  visibility(visible, ctx) {
    if (visible) void load(ctx)
  },
  refresh: (ctx) => load(ctx)
})
