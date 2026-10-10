/**
 * Visual loopback demo: two lockstep peers rendered side-by-side in one
 * page, exchanging real wire-protocol messages over a simulated network.
 * Proves "two sims in one page" visually: both viewports must show the
 * identical battle, with live hash comparison.
 *
 * Controls: network profile, simulation speed, inject-desync button
 * (corrupts peer 1 and watches the snapshot resync recover).
 */
import { Renderer } from '../render/renderer.ts'
import { createLockstepSession } from './session.ts'
import type { LiveSession } from './session.ts'
import { hashWorldState, hashToHex } from './hash.ts'
import {
  NET_PERFECT,
  NET_LAN,
  NET_WIFI,
  NET_LTE,
  NET_BAD,
} from './transport.ts'
import type { NetProfile } from './transport.ts'

const PROFILES: Record<string, NetProfile> = {
  Perfect: NET_PERFECT,
  LAN: NET_LAN,
  WiFi: NET_WIFI,
  LTE: NET_LTE,
  Bad: NET_BAD,
}

export function startLoopbackDemo(): void {
  const app = document.getElementById('app')
  if (!app) throw new Error('#app missing')
  app.innerHTML = ''

  // Layout.
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'display:flex;flex-direction:column;height:100vh;background:#0b0e14;color:#e6edf3;font-family:system-ui'
  const bar = document.createElement('div')
  bar.style.cssText =
    'display:flex;gap:8px;align-items:center;padding:8px 12px;background:#11161f;flex-wrap:wrap'
  const views = document.createElement('div')
  views.style.cssText = 'display:flex;flex:1;min-height:0'
  const hud = document.createElement('div')
  hud.style.cssText = 'padding:8px 12px;background:#11161f;font-size:13px;white-space:pre-wrap'
  wrap.append(bar, views, hud)
  app.append(wrap)

  const mkView = (label: string): { canvas: HTMLCanvasElement; renderer: Renderer } => {
    const box = document.createElement('div')
    box.style.cssText = 'flex:1;position:relative;min-width:0'
    const tag = document.createElement('div')
    tag.textContent = label
    tag.style.cssText =
      'position:absolute;top:8px;left:8px;background:#000a;padding:4px 10px;border-radius:6px;font-size:13px;z-index:2'
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:100%;height:100%;display:block'
    box.append(tag, canvas)
    views.append(box)
    const renderer = new Renderer(canvas)
    return { canvas, renderer }
  }
  const v0 = mkView('Peer 0 (you)')
  const v1 = mkView('Peer 1 (opponent)')

  const resize = (): void => {
    for (const v of [v0, v1]) {
      const r = v.canvas.getBoundingClientRect()
      v.renderer.resize(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)))
      v.renderer.centerOn(0, 0, 5)
    }
  }
  window.addEventListener('resize', resize)

  // Controls.
  const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      'background:#1c2534;color:#e6edf3;border:1px solid #2d3a4f;border-radius:6px;padding:6px 10px;cursor:pointer'
    b.onclick = fn
    bar.append(b)
    return b
  }

  let session: LiveSession = createLockstepSession({ turns: 1e9, net: NET_LTE })
  let speed = 4
  let running = true
  let profileName = 'LTE'

  const rebuild = (profile: NetProfile): void => {
    session = createLockstepSession({ turns: 1e9, net: profile })
    resize()
  }

  const profileSel = document.createElement('select')
  profileSel.style.cssText =
    'background:#1c2534;color:#e6edf3;border:1px solid #2d3a4f;border-radius:6px;padding:6px'
  for (const name of Object.keys(PROFILES)) {
    const o = document.createElement('option')
    o.value = name
    o.textContent = `Net: ${name}`
    profileSel.append(o)
  }
  profileSel.value = profileName
  profileSel.onchange = () => {
    profileName = profileSel.value
    rebuild(PROFILES[profileName])
  }
  bar.append(profileSel)

  for (const s of [1, 4, 16]) mkBtn(`${s}x`, () => { speed = s })
  mkBtn('Pause', () => { running = !running })
  const desyncBtn = mkBtn('💥 Inject desync', () => {
    session.corruptPeer(1)
    desyncBtn.style.borderColor = '#f85149'
    setTimeout(() => { desyncBtn.style.borderColor = '#2d3a4f' }, 1500)
  })
  void desyncBtn
  mkBtn('Reset', () => rebuild(PROFILES[profileName]))

  resize()

  let lastReal = performance.now()
  let acc = 0
  const frame = (now: number): void => {
    requestAnimationFrame(frame)
    const dt = Math.min(100, now - lastReal)
    lastReal = now
    if (running) {
      // Virtual ms to advance this frame (tickMs=5 per session tick).
      acc += dt * speed
      let n = 0
      while (acc >= 5 && n < 200) {
        session.tick()
        acc -= 5
        n += 1
      }
    }
    v0.renderer.render(session.worlds[0], 0)
    v1.renderer.render(session.worlds[1], 1)

    const r = session.getReport()
    const h0 = hashToHex(hashWorldState(session.worlds[0])).slice(0, 8)
    const h1 = hashToHex(hashWorldState(session.worlds[1])).slice(0, 8)
    const t0 = session.peers[0].getCurrentTurn()
    const t1 = session.peers[1].getCurrentTurn()
    const syncMark = h0 === h1 && t0 === t1 ? '✅' : '❌'
    hud.textContent =
      `${syncMark} turn ${t0}/${t1} | sim ${(t0 / 240).toFixed(1)} min | ` +
      `hashes ${h0} / ${h1} | compared ${r.hashesCompared} | ` +
      `desyncs ${r.desyncs} resyncs ${r.resyncs} stalls ${r.stalls} | ` +
      `${(r.bytesPerMinute / 1024).toFixed(2)} KB/min/player`
  }
  requestAnimationFrame(frame)
}
