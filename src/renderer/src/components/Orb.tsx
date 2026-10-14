import { useContext, useEffect, useRef } from 'react'
import { MODE_FRAMES, resolvePreset, type OrbState } from 'thinking-orbs/engine'
import type { Provider } from '../../../shared/chat'
import { ProviderContext } from '../provider'

export type { OrbState }

type Props = {
  state?: OrbState
  size?: number
  paused?: boolean
  className?: string
}

type Ramp = [number, [number, number, number]][]

// Brightness ramps for the dots. The library paints in grayscale; Custard
// paints the same dots in molten metal for Claude, cool steel for OpenAI and
// deep blue for DeepSeek.
const RAMPS: Record<Provider, Ramp> = {
  claude: [
    [0, [58, 43, 29]],
    [0.45, [180, 83, 26]],
    [0.7, [224, 138, 30]],
    [0.88, [255, 205, 110]],
    [1, [255, 243, 214]]
  ],
  openai: [
    [0, [47, 58, 72]],
    [0.45, [79, 107, 140]],
    [0.7, [113, 144, 179]],
    [0.88, [188, 207, 228]],
    [1, [240, 245, 250]]
  ],
  deepseek: [
    [0, [27, 38, 68]],
    [0.45, [47, 79, 194]],
    [0.7, [77, 114, 240]],
    [0.88, [174, 194, 255]],
    [1, [236, 241, 255]]
  ]
}

function inkAt(ramp: Ramp, b: number, alpha: number): string {
  let i = 1
  while (i < ramp.length - 1 && b > ramp[i][0]) i++
  const [p0, c0] = ramp[i - 1]
  const [p1, c1] = ramp[i]
  const t = Math.min(1, Math.max(0, (b - p0) / (p1 - p0)))
  const [r, g, bl] = c0.map((v, k) => Math.round(v + (c1[k] - v) * t))
  return `rgba(${r},${g},${bl},${alpha})`
}

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Dotted thinking orb from thinking-orbs (MIT, Jakub Antalik), drawn with
// its geometry engine. Each state is a different animation, so the orb
// shows what Claude is doing: searching notes, writing, thinking.
function Orb({
  state = 'breathing',
  size = 20,
  paused = false,
  className = ''
}: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const provider = useContext(ProviderContext)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)

    // Two tuned designs ship (64 and 20 px); larger and smaller orbs scale
    // the nearest one.
    const preset = size >= 40 ? 64 : 20
    const { mode, speed, opts } = resolvePreset(state, preset)
    const frameAt = MODE_FRAMES[mode]
    const ramp = RAMPS[provider]

    const draw = (t: number): void => {
      ctx.setTransform(dpr * (size / preset), 0, 0, dpr * (size / preset), 0, 0)
      ctx.clearRect(0, 0, preset, preset)
      const { dots, lines } = frameAt(preset, t * speed, opts)
      for (const l of lines) {
        ctx.strokeStyle = inkAt(ramp, 1 - l.white, l.a ?? 1)
        ctx.lineWidth = l.w
        ctx.beginPath()
        ctx.moveTo(l.x1, l.y1)
        ctx.lineTo(l.x2, l.y2)
        ctx.stroke()
      }
      for (const d of dots) {
        ctx.fillStyle = inkAt(ramp, 1 - Math.min(1, Math.max(0, d.white)), d.a ?? 1)
        ctx.beginPath()
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    if (paused || reducedMotion()) {
      draw(0.6)
      return
    }
    let raf = 0
    const loop = (): void => {
      draw(performance.now() / 1000)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [state, size, paused, provider])

  return (
    <canvas
      ref={ref}
      className={`shrink-0 drop-shadow-[0_0_6px_rgb(var(--glow)/0.35)] ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

export default Orb
