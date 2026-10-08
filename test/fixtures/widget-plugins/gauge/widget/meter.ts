import {
  defineWidget,
  type WidgetContext,
  type WidgetPresentation
} from 'custard-plugin-sdk/widget'

// A canvas widget with no tool calls: it draws whatever the assistant passed
// in, and changes shape between compact (a bar) and expanded (a dial).

let canvas: HTMLCanvasElement
let caption: HTMLElement

const read = (input: unknown): { value: number; caption: string } => {
  const i = (input ?? {}) as { value?: unknown; caption?: unknown }
  const v =
    typeof i.value === 'number' && Number.isFinite(i.value)
      ? Math.min(100, Math.max(0, i.value))
      : 0
  return { value: v, caption: typeof i.caption === 'string' ? i.caption : '' }
}

function draw(ctx: WidgetContext, p: WidgetPresentation = ctx.presentation): void {
  const { value, caption: text } = read(ctx.input)
  const css = getComputedStyle(document.documentElement)
  const accent = css.getPropertyValue('--custard-accent').trim() || '#f5ae3f'
  const track = css.getPropertyValue('--custard-border').trim() || '#2a1f15'
  const expanded = p === 'expanded'
  const h = expanded ? 170 : 44
  ctx.setHeight(h + 28)
  const ratio = devicePixelRatio || 1
  const w = canvas.clientWidth || 300
  canvas.width = w * ratio
  canvas.height = h * ratio
  canvas.style.height = `${h}px`
  const g = canvas.getContext('2d')!
  g.scale(ratio, ratio)
  g.clearRect(0, 0, w, h)
  g.lineCap = 'round'
  if (expanded) {
    const r = Math.min(w / 2, h) - 16
    g.lineWidth = 14
    g.strokeStyle = track
    g.beginPath()
    g.arc(w / 2, h - 8, r, Math.PI, 2 * Math.PI)
    g.stroke()
    g.strokeStyle = accent
    g.beginPath()
    g.arc(w / 2, h - 8, r, Math.PI, Math.PI + (Math.PI * value) / 100)
    g.stroke()
  } else {
    g.lineWidth = 10
    g.strokeStyle = track
    g.beginPath()
    g.moveTo(14, h / 2)
    g.lineTo(w - 14, h / 2)
    g.stroke()
    g.strokeStyle = accent
    g.beginPath()
    g.moveTo(14, h / 2)
    g.lineTo(14 + ((w - 28) * value) / 100, h / 2)
    g.stroke()
  }
  caption.textContent = `${text ? `${text}: ` : ''}${Math.round(value)}`
  document.body.dataset.value = String(value)
  document.body.dataset.presentation = p
}

export default defineWidget({
  mount(root, ctx) {
    root.innerHTML = `
      <style>
        #widget-root { padding: 4px 14px 6px; font: 12px var(--custard-font, sans-serif); color: var(--custard-text-muted, #aaa); }
        canvas { width: 100%; display: block; }
      </style>
      <canvas></canvas><div class="caption"></div>`
    canvas = root.querySelector('canvas')!
    caption = root.querySelector('.caption')!
    draw(ctx)
  },
  update: (_input, ctx) => draw(ctx),
  presentation: (p, ctx) => draw(ctx, p)
})
