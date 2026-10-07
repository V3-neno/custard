import { useEffect, useRef } from 'react'
import { MODE_FRAMES, resolvePreset, type OrbState } from 'thinking-orbs/engine'

export type { OrbState }

type Props = {
  state?: OrbState
  size?: number
  paused?: boolean
  className?: string
}

// Brightness ramp from dark iron to white-hot gold. The library paints in
// grayscale; Custard paints the same dots in molten metal instead.
const RAMP: [number, [number, number, number]][] = [
  [0, [58, 43, 29]],
  [0.45, [180, 83, 26]],
  [0.7, [224, 138, 30]],
  [0.88, [255, 205, 110]],
  [1, [255, 243, 214]]
]

function molten(b: number, alpha: number): string {
  let i = 1
  while (i < RAMP.length - 1 && b > RAMP[i][0]) i++
  const [p0, c0] = RAMP[i - 1]
  const [p1, c1] = RAMP[i]
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

    const draw = (t: number): void => {
      ctx.setTransform(dpr * (size / preset), 0, 0, dpr * (size / preset), 0, 0)
      ctx.clearRect(0, 0, preset, preset)
      const { dots, lines } = frameAt(preset, t * speed, opts)
      for (const l of lines) {
        ctx.strokeStyle = molten(1 - l.white, l.a ?? 1)
        ctx.lineWidth = l.w
        ctx.beginPath()
        ctx.moveTo(l.x1, l.y1)
        ctx.lineTo(l.x2, l.y2)
        ctx.stroke()
      }
      for (const d of dots) {
        ctx.fillStyle = molten(1 - Math.min(1, Math.max(0, d.white)), d.a ?? 1)
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
  }, [state, size, paused])

  return (
    <canvas
      ref={ref}
      className={`shrink-0 drop-shadow-[0_0_6px_rgb(245_174_63/0.35)] ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

export default Orb
