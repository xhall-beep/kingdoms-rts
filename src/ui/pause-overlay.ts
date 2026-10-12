/**
 * Campaign pause/resume UI — single-player / campaign ONLY, never PvP.
 *
 * Self-contained DOM module. The host (main.ts) supplies the Engine
 * callbacks; this module never touches sim state, tick logic, or the hash.
 * PvP matches must remain unpausable: the host's `canPause` gates every
 * pause path, including auto-pause on tab hide.
 */

export interface PauseHost {
  /** Whether pausing is allowed right now (must be false in PvP). */
  canPause: () => boolean
  /** Freeze the sim loop (Engine.pause). */
  pause: () => void
  /** Resume the sim loop (Engine.resume). */
  resume: () => void
  /** Serialize the campaign snapshot, persist it, and return to the menu. */
  saveAndQuit: () => void
  /** Current pause state, owned by the host/Engine. */
  isPaused: () => boolean
}

let host: PauseHost | null = null
let pauseBtn: HTMLButtonElement | null = null
let overlayEl: HTMLElement | null = null
let mountTimer: number | null = null
let stylesInjected = false

export function initPauseUi(h: PauseHost): void {
  host = h
  injectStyles()
  const tryMount = (): boolean => {
    if (pauseBtn) return true
    const bar = document.querySelector('.hud-bar')
    if (!bar) return false
    pauseBtn = document.createElement('button')
    pauseBtn.type = 'button'
    pauseBtn.className = 'hud-pause-btn'
    pauseBtn.title = 'Pause'
    pauseBtn.textContent = '\u23F8'
    pauseBtn.addEventListener('click', () => {
      void togglePause()
    })
    bar.appendChild(pauseBtn)
    refreshPauseUi()
    return true
  }
  if (!tryMount() && mountTimer === null) {
    mountTimer = window.setInterval(() => {
      if (tryMount() && mountTimer !== null) {
        window.clearInterval(mountTimer)
        mountTimer = null
      }
    }, 300)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void autoPause()
  })
}

/** Re-evaluate button visibility and overlay state (e.g. after mode changes). */
export function refreshPauseUi(): void {
  if (pauseBtn && host) {
    pauseBtn.style.display = host.canPause() ? '' : 'none'
  }
  if (host && !host.isPaused()) hideOverlay()
}

/** Programmatic pause entry point (e.g. for auto-pause). Returns true if paused. */
export function requestPause(): boolean {
  if (!host || !host.canPause() || host.isPaused()) return false
  host.pause()
  showOverlay()
  return true
}

/** Programmatic resume entry point. Returns true if resumed. */
export function requestResume(): boolean {
  if (!host || !host.isPaused()) return false
  host.resume()
  hideOverlay()
  return true
}

async function togglePause(): Promise<void> {
  if (!host || !host.canPause()) return
  if (host.isPaused()) {
    requestResume()
  } else {
    requestPause()
  }
}

async function autoPause(): Promise<void> {
  // Nice-to-have: auto-pause when the tab becomes hidden. Gated by canPause
  // so PvP matches are never affected.
  requestPause()
}

function showOverlay(): void {
  hideOverlay()
  overlayEl = document.createElement('div')
  overlayEl.className = 'pause-overlay'
  overlayEl.innerHTML = [
    '<div class="pause-card">',
    '<div class="pause-title">Paused</div>',
    '<button type="button" class="pause-resume">Resume</button>',
    '<button type="button" class="pause-save-quit">Save &amp; Quit to Menu</button>',
    '</div>',
  ].join('')
  overlayEl
    .querySelector('.pause-resume')
    ?.addEventListener('click', () => void togglePause())
  overlayEl
    .querySelector('.pause-save-quit')
    ?.addEventListener('click', () => {
      try {
        host?.saveAndQuit()
      } finally {
        hideOverlay()
      }
    })
  // Block game input while paused.
  overlayEl.addEventListener('pointerdown', (e) => e.stopPropagation())
  overlayEl.addEventListener('keydown', (e) => e.stopPropagation())
  document.body.appendChild(overlayEl)
}

function hideOverlay(): void {
  if (overlayEl) {
    overlayEl.remove()
    overlayEl = null
  }
}

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.hud-pause-btn {',
    '  background: rgba(20, 16, 8, 0.85);',
    '  border: 1px solid #c9a227;',
    '  pointer-events: auto;',
    '  color: #f0d878;',
    '  border-radius: 6px;',
    '  padding: 4px 10px;',
    '  font-size: 13px;',
    '  cursor: pointer;',
    '  margin-left: 8px;',
    '}',
    '.hud-pause-btn:hover { background: rgba(60, 48, 16, 0.9); }',
    '.pause-overlay {',
    '  position: fixed;',
    '  inset: 0;',
    '  background: rgba(0, 0, 0, 0.55);',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  z-index: 2000;',
    '}',
    '.pause-card {',
    '  background: rgba(12, 10, 6, 0.97);',
    '  border: 1px solid #c9a227;',
    '  border-radius: 12px;',
    '  padding: 24px 28px;',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 12px;',
    '  min-width: 260px;',
    '  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.7);',
    '}',
    '.pause-title {',
    '  color: #f0d878;',
    '  font-size: 20px;',
    '  font-weight: bold;',
    '  text-align: center;',
    '  margin-bottom: 4px;',
    '}',
    '.pause-resume, .pause-save-quit {',
    '  background: #2a2416;',
    '  border: 1px solid #c9a227;',
    '  color: #f0d878;',
    '  border-radius: 8px;',
    '  padding: 10px 16px;',
    '  font-size: 14px;',
    '  cursor: pointer;',
    '}',
    '.pause-resume:hover, .pause-save-quit:hover { background: #3d3419; }',
  ].join('\n')
  document.head.appendChild(style)
}
