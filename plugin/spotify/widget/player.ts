import { defineWidget, type WidgetDefinition, type WidgetPresentation } from 'custard-plugin-sdk/widget'
import { ARTWORK_REASON } from '../src/widget-data'
import { BACK_REASON, HEIGHT, PlayerController, SEEK_WARNING } from './controller'
import { availabilityNotice, refreshDisabled } from './availability'

export const time = (ms: number | null): string => ms === null ? '--:--' :
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

const CSS = `
*{box-sizing:border-box}body{margin:0}button,input{font:inherit}
.player{height:100%;overflow:auto;scrollbar-width:none;padding:10px 12px;color:var(--custard-text,#eee);background:var(--custard-surface,#202124);font:13px/1.4 var(--custard-font,system-ui);border-radius:10px}
.player::-webkit-scrollbar{display:none;width:0;height:0}
.summary{display:flex;align-items:center;gap:12px;min-width:0}.art{width:48px;height:48px;flex:none;display:grid;place-items:center;background:var(--custard-accent-soft,#34413d);border-radius:8px;font-size:28px;color:var(--custard-accent,#7dd4a3)}
.meta{min-width:0;flex:1}.title{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.artists,.device{color:var(--custard-text-muted,#bbb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.controls,.volume{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}button{border:1px solid var(--custard-border,#667);border-radius:6px;padding:5px 10px;background:var(--custard-surface-raised,#333);color:inherit;cursor:pointer;min-height:32px}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,.player:focus-visible{outline:3px solid var(--custard-accent,#7dd4a3);outline-offset:2px}
.seek-row{display:flex;gap:8px;align-items:center}.seek-row input{min-width:40px;flex:1;accent-color:var(--custard-accent,#7dd4a3)}.clock{font-variant-numeric:tabular-nums;white-space:nowrap}.notice{margin-top:6px;color:var(--custard-text-muted,#bbb);overflow-wrap:anywhere}.expanded .art{width:64px;height:64px}.expanded .title,.expanded .artists{white-space:normal}.expanded .summary{align-items:flex-start}[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

export function createPlayerWidget(clock = () => Date.now()): WidgetDefinition {
  let controller: PlayerController | undefined
  let draw: (() => void) | undefined
  let layout: ((p: WidgetPresentation) => void) | undefined
  let cleanup: (() => void) | undefined
  let cancelDraft: (() => void) | undefined
  return defineWidget({
    mount(root, ctx) {
      const doc = root.ownerDocument
      const win = doc.defaultView
      const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', label = ''): HTMLElementTagNameMap[K] => {
        const el = doc.createElement(tag)
        el.className = className
        el.textContent = label
        return el
      }
      const style = element('style'); style.textContent = CSS
      const panel = element('section', 'player')
      panel.setAttribute('aria-label', 'Spotify playback controls')
      panel.tabIndex = 0 // Preserve keyboard scrolling at narrow widths; scrollbar is hidden.
      const summary = element('div', 'summary')
      const art = element('div', 'art', '♫')
      art.setAttribute('role', 'img'); art.setAttribute('aria-label', 'Album artwork unavailable')
      art.title = ARTWORK_REASON
      const meta = element('div', 'meta')
      const title = element('div', 'title', 'Spotify playback')
      const artists = element('div', 'artists')
      const device = element('div', 'device', 'Playback not loaded')
      meta.append(title, artists, device); summary.append(art, meta)
      const controls = element('div', 'controls')
      const back = element('button', '', 'Back')
      back.type = 'button'; back.disabled = true; back.title = BACK_REASON
      back.setAttribute('aria-label', BACK_REASON)
      const toggle = element('button', '', 'Play / pause')
      const next = element('button', '', 'Next')
      const restart = element('button', '', 'Restart')
      const refresh = element('button', '', 'Refresh')
      refresh.title = 'Check Spotify playback without starting or transferring it'
      refresh.setAttribute('aria-label', 'Refresh Spotify playback status')
      for (const button of [toggle, next, restart, refresh]) button.type = 'button'
      next.setAttribute('aria-label', 'Next track')
      restart.setAttribute('aria-label', 'Restart current track without resuming')
      controls.append(back, toggle, next, restart, refresh)
      const seekRow = element('div', 'seek-row')
      const elapsed = element('span', 'clock', '--:--'); elapsed.setAttribute('aria-label', 'Elapsed time')
      const range = element('input')
      range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '1'; range.value = '0'
      range.setAttribute('aria-label', 'Seek position; release to seek')
      range.setAttribute('aria-describedby', 'seek-help')
      range.title = `Release to seek. ${SEEK_WARNING}`
      const duration = element('span', 'clock', '--:--'); duration.setAttribute('aria-label', 'Track duration')
      seekRow.append(elapsed, range, duration)
      const volume = element('div', 'volume')
      const lower = element('button', '', '−')
      const higher = element('button', '', '+')
      lower.type = higher.type = 'button'
      lower.title = 'Lower Spotify volume by 5 percentage points'
      higher.title = 'Raise Spotify volume by 5 percentage points'
      lower.setAttribute('aria-label', lower.title); higher.setAttribute('aria-label', higher.title)
      const level = element('span', 'clock', 'Volume —')
      volume.append(lower, level, higher)
      const notice = element('div', 'notice')
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
      const seekHelp = element('span', 'sr-only', SEEK_WARNING); seekHelp.id = 'seek-help'
      panel.append(summary, controls, seekRow, volume, notice, seekHelp)
      root.replaceChildren(style, panel)

      let draft: { position: number; uri: string | null; device: string | null } | null = null
      let frame: number | null = null
      let dead = false
      const listeners: (() => void)[] = []
      const listen = (el: HTMLElement, event: string, fn: () => void): void => {
        el.addEventListener(event, fn)
        listeners.push(() => el.removeEventListener(event, fn))
      }
      const setText = (el: HTMLElement, value: string): void => {
        if (el.textContent !== value) el.textContent = value
      }
      const stopAnimation = (): void => {
        if (frame !== null) win?.cancelAnimationFrame(frame)
        frame = null
      }
      const render = (): void => {
        if (dead) return
        const c = controller!, s = c.snapshot
        if (draft && (draft.uri !== s?.trackUri || draft.device !== s?.deviceId || c.stale())) draft = null
        const noActive = !!s && !c.stale() && (!s.active || !s.deviceId || s.state === 'unavailable')
        setText(title, noActive ? 'No active Spotify device' : s?.title ?? 'Spotify playback')
        setText(artists, noActive ? '' : s?.artists.join(', ') ?? '')
        setText(device, !s ? 'Playback not loaded' : noActive ? 'Start playback in Spotify to connect.' : s.deviceName)
        const playing = s?.state === 'playing'
        const toggleAction = playing ? 'pause_playback' : 'resume_playback'
        setText(toggle, playing ? 'Pause' : 'Resume')
        toggle.setAttribute('aria-label', playing ? 'Pause Spotify playback' : 'Resume existing Spotify playback')
        toggle.disabled = !c.can(toggleAction)
        next.disabled = !c.can('next_track')
        restart.disabled = !c.can('seek')
        refresh.disabled = refreshDisabled(c)
        setText(refresh, c.reading ? 'Checking…' : 'Refresh')
        range.disabled = !c.can('seek')
        lower.disabled = !c.can('adjust_volume') || s?.volume === 0
        higher.disabled = !c.can('adjust_volume') || s?.volume === 100
        setText(level, `Volume ${s?.volume === null || s?.volume === undefined ? '—' : `${s.volume}%`}`)
        volume.title = s?.volumeSupported ? 'Spotify device volume' : 'Volume control unavailable on this device'
        const position = draft?.position ?? c.position()
        setText(elapsed, time(position)); setText(duration, time(s?.duration ?? null))
        range.max = String(Math.max(0, (s?.duration ?? 1) - 1))
        range.value = String(Math.min(Number(range.max), position ?? 0))
        range.setAttribute('aria-valuetext', `${time(position)} of ${time(s?.duration ?? null)}`)
        const message = availabilityNotice(c)
        setText(notice, message); notice.hidden = !message
        panel.setAttribute('aria-busy', String(c.pending || c.reading))
        if (c.visible && ctx.visible && playing && !c.stale() && s?.position !== null && !dead) {
          if (frame === null && win) frame = win.requestAnimationFrame(() => { frame = null; render() })
        } else stopAnimation()
      }
      controller = new PlayerController(ctx, render, clock)
      draw = render
      cancelDraft = () => { draft = null; render() }
      layout = (p) => {
        panel.className = `player ${p === 'expanded' ? 'expanded' : 'compact'}`
        restart.hidden = p !== 'expanded'
        root.style.height = `${HEIGHT[p]}px`; ctx.setHeight(HEIGHT[p]); render()
      }
      listen(refresh, 'click', () => { cancelDraft?.(); void controller!.read() })
      listen(toggle, 'click', () => { void controller!.action(controller!.snapshot?.state === 'playing' ? 'pause_playback' : 'resume_playback') })
      listen(next, 'click', () => { void controller!.action('next_track') })
      listen(restart, 'click', () => { void controller!.action('seek', 0) })
      listen(lower, 'click', () => { void controller!.action('adjust_volume', -5) })
      listen(higher, 'click', () => { void controller!.action('adjust_volume', 5) })
      listen(range, 'input', () => {
        if (!controller!.can('seek')) return
        draft = { position: Number(range.value), uri: controller!.snapshot?.trackUri ?? null, device: controller!.snapshot?.deviceId ?? null }
        render()
      })
      // Native range change commits at pointer release (or keyboard change).
      listen(range, 'change', () => {
        const selected = draft
        draft = null
        const c = controller!
        if (!selected || selected.uri !== c.snapshot?.trackUri || selected.device !== c.snapshot?.deviceId || !c.can('seek')) { render(); return }
        void c.action('seek', selected.position)
      })
      listen(range, 'pointercancel', () => cancelDraft?.())
      listen(range, 'blur', () => cancelDraft?.())
      cleanup = () => {
        dead = true; draft = null; controller?.dispose(); stopAnimation()
        listeners.forEach((remove) => remove()); root.replaceChildren()
      }
      layout(ctx.presentation)
    },
    visibility(visible) { if (!visible) cancelDraft?.(); controller?.setVisible(visible) },
    refresh() { return controller?.read() },
    update() { draw?.() },
    presentation(p) { cancelDraft?.(); layout?.(p) },
    unmount() { cleanup?.(); cleanup = undefined; draw = undefined; layout = undefined; cancelDraft = undefined }
  })
}

export default createPlayerWidget()
