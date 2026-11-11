/**
 * PvP Lobby UI — create/join rooms for online multiplayer.
 *
 * Phase 3: Private rooms via friend codes.
 * Server: https://kingdoms-pvp.stephen-x-hall.workers.dev
 */

import { PvPClient, getPlayerId, getPlayerName, setPlayerName } from '../net/client.ts'
import { buildProgressionSnapshot, loadProfile } from '../profile/profile.ts'

const SERVER_URL = 'wss://kingdoms-pvp.stephen-x-hall.workers.dev'

import type { AiPracticeTier } from '../net/pvp-ai.ts'

export interface PvPLobbyCallbacks {
  onMatchStart: (slot: 0 | 1, opponentName: string) => void
  onPracticeStart?: (tier: AiPracticeTier) => void
  onError: (message: string) => void
}

export class PvPLobby {
  private root: HTMLElement | null = null
  private client: PvPClient | null = null
  private callbacks: PvPLobbyCallbacks | null = null
  private queueWs: WebSocket | null = null
  /** Room code from the matchmaker, waiting out the match-found countdown. */
  private pendingMatch: { code: string } | null = null
  private matchFoundTimer: ReturnType<typeof setTimeout> | null = null
  private matchFoundInterval: ReturnType<typeof setInterval> | null = null
  private matchFoundRemaining = 0

  mount(parent: HTMLElement, callbacks: PvPLobbyCallbacks): void {
    this.callbacks = callbacks
    this.root = document.createElement('div')
    this.root.className = 'pvp-lobby'
    this.root.hidden = true
    this.root.innerHTML = `
      <div class="pvp-lobby-panel">
        <h2>⚔️ Online PvP</h2>
        <div class="pvp-row">
          <label>Name:
            <input type="text" id="pvp-name" maxlength="16"
                   value="${getPlayerName()}" placeholder="Your name" />
          </label>
        </div>
        <div class="pvp-row">
          <button class="hud-pill hud-mode pvp-quick" id="pvp-quick">⚡ Quick Match</button>
        </div>
        <div class="pvp-row" id="pvp-queue-display" hidden>
          <p class="pvp-searching">🔍 Searching for opponent...</p>
          <p id="pvp-queue-count"></p>
          <button class="hud-pill" id="pvp-cancel">Cancel</button>
        </div>
        <div class="pvp-row" id="pvp-match-found" hidden>
          <p class="pvp-found-title">⚔️ Match found!</p>
          <p id="pvp-found-opponent"></p>
          <p id="pvp-found-rating"></p>
          <p id="pvp-found-countdown"></p>
        </div>
        <div class="pvp-row">
          <button class="hud-pill hud-mode" id="pvp-create">Create Room</button>
        </div>
        <div class="pvp-row" id="pvp-code-display" hidden>
          <p>Share this code:</p>
          <p class="pvp-code" id="pvp-code"></p>
          <p class="pvp-waiting">Waiting for opponent...</p>
        </div>
        <div class="pvp-row">
          <input type="text" id="pvp-join-code" maxlength="6"
                 placeholder="Enter code" style="text-transform:uppercase" />
          <button class="hud-pill hud-mode" id="pvp-join">Join Room</button>
        </div>
        <div class="pvp-row" id="pvp-close-row">
          <button class="hud-pill" id="pvp-close">Close</button>
        </div>
        <hr class="pvp-divider" />
        <div class="pvp-row">
          <p class="pvp-section-title">🤖 Practice vs AI (offline, lockstep)</p>
        </div>
        <div class="pvp-row pvp-practice-row">
          <button class="hud-pill hud-mode" data-tier="passive">🛡️ Passive</button>
          <button class="hud-pill hud-mode" data-tier="normal">⚔️ Normal</button>
          <button class="hud-pill hud-mode" data-tier="aggressive">🔥 Aggressive</button>
        </div>
        <div class="pvp-status" id="pvp-status"></div>
      </div>
    `
    parent.appendChild(this.root)
    this.wireEvents()
  }

  show(): void {
    if (this.root) this.root.hidden = false
  }

  hide(): void {
    // Leaving the lobby abandons a pending match-found: clear the
    // countdown so a hidden lobby never auto-enters a match, and drop
    // the pending room (the opponent's room times out server-side).
    this.clearMatchFound()
    if (this.root) this.root.hidden = true
  }

  get isVisible(): boolean {
    return this.root ? !this.root.hidden : false
  }

  private wireEvents(): void {
    if (!this.root) return

    const nameInput = this.root.querySelector<HTMLInputElement>('#pvp-name')
    const createBtn = this.root.querySelector('#pvp-create')
    const joinBtn = this.root.querySelector('#pvp-join')
    const joinCodeInput = this.root.querySelector<HTMLInputElement>('#pvp-join-code')
    const closeBtn = this.root.querySelector('#pvp-close')

    nameInput?.addEventListener('change', () => {
      if (nameInput.value.trim()) {
        setPlayerName(nameInput.value.trim())
      }
    })

    const quickBtn = this.root.querySelector('#pvp-quick')
    const cancelBtn = this.root.querySelector('#pvp-cancel')
    quickBtn?.addEventListener('click', () => this.joinQueue())
    cancelBtn?.addEventListener('click', () => this.leaveQueue())
    createBtn?.addEventListener('click', () => this.createRoom())
    joinBtn?.addEventListener('click', () => {
      const code = joinCodeInput?.value.trim().toUpperCase()
      if (code && code.length === 6) {
        this.joinRoom(code)
      } else {
        this.setStatus('Enter a 6-letter code')
      }
    })
    closeBtn?.addEventListener('click', () => this.hide())

    // Practice vs AI: offline lockstep match against the deterministic AI.
    this.root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tier = btn.dataset.tier as AiPracticeTier
        if (tier === 'passive' || tier === 'normal' || tier === 'aggressive') {
          this.hide()
          this.callbacks?.onPracticeStart?.(tier)
        }
      })
    })
  }

  private async createRoom(): Promise<void> {
    this.setStatus('Creating room...')
    try {
      const code = await PvPClient.createRoom(SERVER_URL)
      this.showCode(code)
      this.connect(code)
    } catch (err) {
      this.setStatus('Failed to create room. Check connection.')
      this.callbacks?.onError('Room creation failed')
    }
  }

  private joinRoom(code: string): void {
    this.setStatus(`Joining ${code}...`)
    this.connect(code)
  }

  private connect(code: string): void {
    const nameInput = this.root?.querySelector<HTMLInputElement>('#pvp-name')
    const name = nameInput?.value.trim() || getPlayerName()
    setPlayerName(name)

    this.client = new PvPClient({
      serverUrl: SERVER_URL,
      playerId: getPlayerId(),
      playerName: name,
      onAssigned: (slot) => {
        this.setStatus(`Connected as Player ${slot + 1}`)
      },
      onMatchStart: (players) => {
        const slot = this.client?.playerSlot ?? 0
        const opponent = players.find((p) => p.slot !== slot)
        this.setStatus('Match found!')
        this.hide()
        this.callbacks?.onMatchStart(slot, opponent?.name ?? 'Opponent')
      },
      onTurnBundle: (_bundle) => {
        // Turn bundles are handled by the game loop (Phase 3 integration)
      },
      onHash: (_msg) => {
        // Hash messages for desync detection (Phase 3 integration)
      },
      onOpponentDisconnected: (graceSec) => {
        this.setStatus(`Opponent disconnected — ${graceSec}s to reconnect…`)
      },
      onPlayerJoined: (count) => {
        this.setStatus(`${count}/2 players`)
      },
    })

    this.client.connect(code)
  }

  private showCode(code: string): void {
    const display = this.root?.querySelector<HTMLElement>('#pvp-code-display')
    const codeEl = this.root?.querySelector('#pvp-code')
    if (display && codeEl) {
      display.hidden = false
      codeEl.textContent = code
    }
  }

  private setStatus(msg: string): void {
    const el = this.root?.querySelector('#pvp-status')
    if (el) el.textContent = msg
  }

  /** Join the Quick Match queue. */
  private joinQueue(): void {
    const nameInput = this.root?.querySelector<HTMLInputElement>('#pvp-name')
    const name = nameInput?.value.trim() || getPlayerName()
    setPlayerName(name)

    // Show queue UI
    const queueDisplay = this.root?.querySelector<HTMLElement>('#pvp-queue-display')
    if (queueDisplay) queueDisplay.hidden = false
    this.setStatus('Connecting to matchmaker...')

    // Progression snapshot for power-band matchmaking, built from the
    // persistent kingdom profile. The server computes the hidden Power
    // Score from this (never exposed to clients).
    const progression = btoa(JSON.stringify(buildProgressionSnapshot(loadProfile())))
    const wsUrl = `${SERVER_URL}/api/queue/ws?playerId=${encodeURIComponent(getPlayerId())}&name=${encodeURIComponent(name)}&progression=${encodeURIComponent(progression)}`
    this.queueWs = new WebSocket(wsUrl)

    this.queueWs.onmessage = (event) => {
      let msg: { kind?: string; position?: number; inQueue?: number; code?: string; slot?: 0 | 1; band?: string; matchId?: string; secret?: string; yourRating?: number; opponent?: { playerId: string; name: string } }
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }

      switch (msg.kind) {
        case 'queued':
          const band = msg.band ? ` [${msg.band}]` : ''
          this.setStatus(`In queue (position ${msg.position ?? '?'})${band}`)
          break
        case 'queue_status':
          this.updateQueueCount(msg.inQueue ?? 0)
          break
        case 'matched':
          this.onQueueMatched(msg.code!, msg.slot!, msg.opponent?.playerId ?? '', msg.opponent?.name ?? 'Opponent', msg.matchId ?? '', msg.secret ?? '', msg.yourRating ?? 1200)
          break
      }
    }

    this.queueWs.onclose = () => {
      this.queueWs = null
      const qd = this.root?.querySelector<HTMLElement>('#pvp-queue-display')
      if (qd) qd.hidden = true
    }

    this.queueWs.onerror = () => {
      this.setStatus('Could not reach matchmaker')
      const qd = this.root?.querySelector<HTMLElement>('#pvp-queue-display')
      if (qd) qd.hidden = true
    }
  }

  /** Leave the Quick Match queue. */
  private leaveQueue(): void {
    if (this.queueWs) {
      try {
        this.queueWs.send(JSON.stringify({ kind: 'leave' }))
        this.queueWs.close()
      } catch { /* ignore */ }
      this.queueWs = null
    }
    const qd = this.root?.querySelector<HTMLElement>('#pvp-queue-display')
    if (qd) qd.hidden = true
    this.setStatus('')
  }

  /** Called when the matchmaker pairs us. Joins the assigned room. */
  private onQueueMatched(code: string, _slot: 0 | 1, opponentId: string, opponentName: string, matchId: string, secret: string, yourRating: number): void {
    // Hide queue UI
    const qd = this.root?.querySelector<HTMLElement>('#pvp-queue-display')
    if (qd) qd.hidden = true
    // Close the queue socket: matching ends queue membership, and merely
    // nulling the reference would orphan an open connection (the server
    // keeps counting the player as queued). leaveQueue/disconnect already
    // close; the matched path was the one path that did not.
    if (this.queueWs) {
      try { this.queueWs.close() } catch { /* ignore */ }
    }
    this.queueWs = null

    // Stash pairing credentials for authenticated result reporting
    const stash = this as unknown as { lastOpponentId: string; lastMatchId: string; lastMatchSecret: string; lastRating: number }
    stash.lastOpponentId = opponentId
    stash.lastMatchId = matchId
    stash.lastMatchSecret = secret
    stash.lastRating = yourRating
    // Show the match-found interstitial; the room join follows the countdown.
    this.showMatchFound(code, opponentName, yourRating)
  }

  /**
   * Match-found interstitial (Quick Match path only): the player sees who
   * they drew and their rating, then auto-enters after a short beat.
   * There is no decline — the matchmaker has no decline protocol and the
   * worker source is gone, so declining would strand the opponent in the
   * room. Close is hidden for the 3s countdown instead of letting the
   * player walk away from a made match.
   */
  private showMatchFound(code: string, opponentName: string, rating: number): void {
    this.pendingMatch = { code }
    this.matchFoundRemaining = 3
    this.setStatus('')
    const found = this.root?.querySelector<HTMLElement>('#pvp-match-found')
    if (found) found.hidden = false
    const oppEl = this.root?.querySelector<HTMLElement>('#pvp-found-opponent')
    if (oppEl) oppEl.textContent = `vs ${opponentName}`
    const ratingEl = this.root?.querySelector<HTMLElement>('#pvp-found-rating')
    if (ratingEl) ratingEl.textContent = `Your rating: ${rating}`
    this.renderMatchFoundCountdown()
    const closeRow = this.root?.querySelector<HTMLElement>('#pvp-close-row')
    if (closeRow) closeRow.hidden = true
    // Timers are a browser-only flourish: the synchronous test harness
    // runs in node with no window, and a pending interval would keep the
    // test process alive. Tests drive enterMatchedRoom() directly.
    if (typeof window !== 'undefined') {
      this.matchFoundInterval = setInterval(() => {
        this.matchFoundRemaining -= 1
        if (this.matchFoundRemaining <= 0) {
          this.enterMatchedRoom()
        } else {
          this.renderMatchFoundCountdown()
        }
      }, 1000)
      this.matchFoundTimer = setTimeout(() => this.enterMatchedRoom(), 3000)
    }
  }

  private renderMatchFoundCountdown(): void {
    const el = this.root?.querySelector<HTMLElement>('#pvp-found-countdown')
    if (el) el.textContent = `Entering match in ${this.matchFoundRemaining}…`
  }

  /**
   * Enter the room the matchmaker assigned. Public so the countdown timer
   * and the test harness share one entry point; a no-op with no pending
   * match, so a stray call can never join a room twice.
   */
  enterMatchedRoom(): void {
    const pending = this.pendingMatch
    if (!pending) return
    this.clearMatchFound()
    this.setStatus('Joining match...')
    this.connect(pending.code)
  }

  /** Clear the match-found countdown and panel; keep the lobby usable. */
  private clearMatchFound(): void {
    if (this.matchFoundInterval !== null) {
      clearInterval(this.matchFoundInterval)
      this.matchFoundInterval = null
    }
    if (this.matchFoundTimer !== null) {
      clearTimeout(this.matchFoundTimer)
      this.matchFoundTimer = null
    }
    this.pendingMatch = null
    const found = this.root?.querySelector<HTMLElement>('#pvp-match-found')
    if (found) found.hidden = true
    const closeRow = this.root?.querySelector<HTMLElement>('#pvp-close-row')
    if (closeRow) closeRow.hidden = false
  }

  /** Opponent's player ID from the last matchmaker pairing (for result reporting). */
  get opponentId(): string {
    return (this as unknown as { lastOpponentId?: string }).lastOpponentId ?? ''
  }

  /** Match ID + secret from the last pairing (authenticates the result report). */
  get matchCredentials(): { matchId: string; secret: string } {
    const s = this as unknown as { lastMatchId?: string; lastMatchSecret?: string }
    return { matchId: s.lastMatchId ?? '', secret: s.lastMatchSecret ?? '' }
  }

  /** Our rating at match start (for the rating-change display). */
  get ratingAtMatchStart(): number {
    return (this as unknown as { lastRating?: number }).lastRating ?? 1200
  }

  private updateQueueCount(count: number): void {
    const el = this.root?.querySelector('#pvp-queue-count')
    if (el) el.textContent = count === 1 ? '1 player waiting' : `${count} players waiting`
  }

  disconnect(): void {
    this.clearMatchFound()
    this.client?.disconnect()
    this.client = null
    if (this.queueWs) {
      try { this.queueWs.close() } catch { /* ignore */ }
      this.queueWs = null
    }
  }

  /** Get the active PvP client (for game integration). */
  getClient(): PvPClient | null {
    return this.client
  }
}
