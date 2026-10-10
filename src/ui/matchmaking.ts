/**
 * Matchmaking overlay: FIND MATCH, join-by-code, waiting room, errors.
 * Mobile-first: fullscreen sheet, thumb-sized targets, big room code.
 */
import { getPlayerName, setPlayerName } from '../net/client.ts'

export interface MatchmakingCallbacks {
  onFindMatch(name: string): void
  onJoinRoom(name: string, code: string): void
  onCancel(): void
  onClose(): void
}

export class MatchmakingUI {
  private root: HTMLElement | null = null
  private cb: MatchmakingCallbacks | null = null
  private countEl: HTMLElement | null = null

  mount(parent: HTMLElement, cb: MatchmakingCallbacks): void {
    this.cb = cb
    const el = document.createElement('div')
    el.className = 'mm-overlay'
    el.hidden = true
    el.innerHTML = `
      <div class="mm-sheet" role="dialog" aria-label="Multiplayer matchmaking">
        <div class="mm-head">
          <h2>⚔️ Multiplayer</h2>
          <button class="mm-close" id="mm-close" aria-label="Close">✕</button>
        </div>
        <div class="mm-body" id="mm-body"></div>
      </div>`
    parent.appendChild(el)
    this.root = el
    el.querySelector('#mm-close')?.addEventListener('click', () => this.cb?.onClose())
  }

  private body(): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>('#mm-body') ?? null
  }

  show(): void {
    if (this.root) this.root.hidden = false
  }

  hide(): void {
    if (this.root) this.root.hidden = true
  }

  get visible(): boolean {
    return !!this.root && !this.root.hidden
  }

  /** Main menu: name field, FIND MATCH, join-by-code. */
  showMenu(): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `
      <label class="mm-label">Your name
        <input class="mm-input" id="mm-name" maxlength="16" value="" placeholder="Player" autocomplete="off" />
      </label>
      <button class="mm-big" id="mm-find">⚔️ FIND MATCH</button>
      <div class="mm-divider"><span>or join a friend</span></div>
      <div class="mm-joinrow">
        <input class="mm-input mm-code-input" id="mm-code" maxlength="6" placeholder="CODE" autocomplete="off" autocapitalize="characters" />
        <button class="mm-btn" id="mm-join">Join</button>
      </div>
      <p class="mm-hint">Fair 1v1 on a mirrored map. First to destroy the enemy Town Hall wins.</p>`
    const nameEl = b.querySelector<HTMLInputElement>('#mm-name')
    if (nameEl) nameEl.value = getPlayerName()
    b.querySelector('#mm-find')?.addEventListener('click', () => {
      const name = (nameEl?.value || 'Player').trim().slice(0, 16) || 'Player'
      setPlayerName(name)
      this.cb?.onFindMatch(name)
    })
    b.querySelector('#mm-join')?.addEventListener('click', () => {
      const name = (nameEl?.value || 'Player').trim().slice(0, 16) || 'Player'
      setPlayerName(name)
      const code = (b.querySelector<HTMLInputElement>('#mm-code')?.value || '')
        .trim()
        .toUpperCase()
      this.cb?.onJoinRoom(name, code)
    })
  }

  showCreating(): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `<div class="mm-status"><div class="mm-spinner"></div><p>Creating room…</p>
      <button class="mm-btn mm-ghost" id="mm-cancel">Cancel</button></div>`
    b.querySelector('#mm-cancel')?.addEventListener('click', () => this.cb?.onCancel())
  }

  showJoining(code: string): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `<div class="mm-status"><div class="mm-spinner"></div><p>Joining room <b>${escapeHtml(code)}</b>…</p>
      <button class="mm-btn mm-ghost" id="mm-cancel">Cancel</button></div>`
    b.querySelector('#mm-cancel')?.addEventListener('click', () => this.cb?.onCancel())
  }

  /** Waiting room: big code + live player count. */
  showWaiting(code: string): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `
      <p class="mm-label">Share this code with your opponent</p>
      <div class="mm-code" id="mm-room-code">${escapeHtml(code)}</div>
      <p class="mm-players"><span id="mm-count">1</span>/2 players</p>
      <div class="mm-status"><div class="mm-spinner"></div><p>Waiting for opponent…</p></div>
      <button class="mm-btn mm-ghost" id="mm-cancel">Leave</button>`
    this.countEl = b.querySelector('#mm-count')
    b.querySelector('#mm-cancel')?.addEventListener('click', () => this.cb?.onCancel())
  }

  setPlayerCount(n: number): void {
    if (this.countEl) this.countEl.textContent = String(n)
  }

  showError(msg: string): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `<div class="mm-status"><p class="mm-error">${escapeHtml(msg)}</p>
      <button class="mm-btn" id="mm-back">Back</button></div>`
    b.querySelector('#mm-back')?.addEventListener('click', () => this.showMenu())
  }

  /** Opponent left mid-match. */
  showDisconnected(onRematch: () => void, onMenu: () => void): void {
    const b = this.body()
    if (!b) return
    b.innerHTML = `<div class="mm-status"><p class="mm-error">Opponent disconnected.</p>
      <div class="mm-row">
        <button class="mm-btn" id="mm-rematch">Rematch</button>
        <button class="mm-btn mm-ghost" id="mm-tomenu">Menu</button>
      </div></div>`
    b.querySelector('#mm-rematch')?.addEventListener('click', onRematch)
    b.querySelector('#mm-tomenu')?.addEventListener('click', onMenu)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}
