/**
 * PvP WebSocket client (Phase 2).
 *
 * Connects to the Cloudflare Worker relay, joins a room via code,
 * and exchanges turn bundles with the opponent. Uses the binary wire
 * protocol (encodeMessage/decodeMessage); bundles are base64-wrapped
 * in the JSON WebSocket frames the relay expects.
 */
import {
  encodeMessage,
  decodeMessage,
  MsgKind,
} from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'

export interface PvPClientConfig {
  serverUrl: string // e.g. "wss://kingdoms-pvp.workers.dev"
  playerId: string
  playerName: string
  onAssigned: (slot: 0 | 1) => void
  onMatchStart: (players: { slot: 0 | 1; name: string }[]) => void
  onTurnBundle: (bundle: InputMsg) => void
  onHash: (msg: HashMsg) => void
  onOpponentDisconnected: (graceSec: number) => void
  onOpponentReconnected?: () => void
  onOpponentForfeited?: () => void
  /** Our own socket dropped; we are attempting to rejoin the match. */
  onReconnecting?: (attempt: number) => void
  /** Our rejoin succeeded (worker sent 'rejoined'). */
  onRejoined?: () => void
  /** Rejoin attempts exhausted (past the worker's grace window). */
  onReconnectFailed?: () => void
  /** Snapshot from the opponent after our rejoin: authoritative state. */
  onResync?: (turn: number, data: Uint8Array) => void
  onPlayerJoined: (count: number) => void
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

export class PvPClient {
  private ws: WebSocket | null = null
  private config: PvPClientConfig
  private slot: 0 | 1 | null = null
  private roomCode: string | null = null
  /** Enabled by the game loop once a match is live; lobby stays manual. */
  private autoReconnect = false
  private reconnectTimer: number | null = null
  private reconnectAttempt = 0
  private reconnectStartMs = 0
  private intentionalClose = false
/** Give up rejoining after this long (worker's grace is 60s + alarm lag). */
private static readonly RECONNECT_GIVE_UP_MS = 75_000

  /** Inbound turn bundles received before the match loop routed a handler. */
  private pendingTurnBundles: InputMsg[] = []
  /** Inbound hashes received before the match loop routed a handler. */
  private pendingHashes: HashMsg[] = []
  /** True once the match loop has routed real handlers via the setters below. */
  private turnBundleRouted = false
  private hashRouted = false
/** Safety cap on pre-match buffered frames (WebSocket delivery is ordered). */
private static readonly MAX_PENDING = 64

  constructor(config: PvPClientConfig) {
    this.config = config
  }

  /** Turn on automatic rejoin attempts (called when a match starts). */
  setAutoReconnect(on: boolean): void {
    this.autoReconnect = on
    if (!on) this.stopReconnectLoop()
  }

  /** Create a new room and return the join code. */
  static async createRoom(serverUrl: string): Promise<string> {
    const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://')
    const res = await fetch(`${httpUrl}/api/room/create`, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to create room')
    const data = (await res.json()) as { code: string }
    return data.code
  }

  /** Connect to a room via code. */
  connect(code: string): void {
    this.roomCode = code
    this.intentionalClose = false
    const { serverUrl, playerId, playerName } = this.config
    const wsUrl = `${serverUrl}/api/room/${code}/ws?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(playerName)}`
    this.ws = new WebSocket(wsUrl)

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string)
    }

    this.ws.onopen = () => {
      // A rejoin that reached the worker is confirmed by its 'rejoined'
      // message; stop retrying as soon as any socket opens.
      this.stopReconnectLoop()
    }

    this.ws.onclose = () => {
      this.ws = null
      if (!this.intentionalClose && this.autoReconnect && this.roomCode) {
        this.startReconnectLoop()
      }
    }
  }

  /**
   * Our own socket dropped mid-match: keep trying to rejoin the same room
   * with the same playerId inside the worker's grace window (~60s).
   */
  private startReconnectLoop(): void {
    if (this.reconnectTimer !== null) return
    this.reconnectAttempt = 0
    this.reconnectStartMs = Date.now()
    const tryReconnect = (): void => {
      if (!this.autoReconnect || !this.roomCode) {
        this.stopReconnectLoop()
        return
      }
      // Past the worker's grace window: the slot is gone, stop retrying.
      if (Date.now() - this.reconnectStartMs > PvPClient.RECONNECT_GIVE_UP_MS) {
        this.stopReconnectLoop()
        this.config.onReconnectFailed?.()
        return
      }
      this.reconnectAttempt += 1
      this.config.onReconnecting?.(this.reconnectAttempt)
      try {
        this.connect(this.roomCode)
      } catch {
        // Will retry on the next tick via onclose, or schedule below.
      }
      // If still down after this attempt, try again in 3s (grace is ~60s).
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) tryReconnect()
      }, 3000)
    }
    tryReconnect()
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
  }

  /** Send an input bundle to the opponent (via relay). */
  sendBundle(bundle: InputMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind: 'turn', data: toBase64(encodeMessage(bundle)) }))
  }

  /** Send a state hash (desync detection). */
  sendHash(msg: HashMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind: 'hash', data: toBase64(encodeMessage(msg)) }))
  }

  /** Send a ping for RTT measurement. */
  sendPing(tSendMs: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        kind: 'ping',
        data: toBase64(encodeMessage({ kind: MsgKind.Ping, seq: 0, tSendMs })),
      }),
    )
  }

  /**
   * Re-route incoming turn bundles after construction (used by the PvP
   * game loop, which is created after the lobby builds this client).
   * Any frames buffered before routing are replayed in arrival order.
   */
  setTurnBundleHandler(cb: (bundle: InputMsg) => void): void {
    this.config.onTurnBundle = cb
    this.turnBundleRouted = true
    const queued = this.pendingTurnBundles
    this.pendingTurnBundles = []
    for (const bundle of queued) cb(bundle)
  }

  /**
   * Re-route incoming hash messages after construction (see above).
   * Any frames buffered before routing are replayed in arrival order.
   */
  setHashHandler(cb: (msg: HashMsg) => void): void {
    this.config.onHash = cb
    this.hashRouted = true
    const queued = this.pendingHashes
    this.pendingHashes = []
    for (const msg of queued) cb(msg)
  }

  /**
   * Pre-match buffering: turn bundles and hashes can arrive between
   * match_start and PvPGame.start() routing the real handlers (the lobby's
   * placeholder handlers are no-ops). Before this, those frames were
   * silently dropped and the lockstep barrier stalled the match forever —
   * the remote peer's opening turns never reached it. Buffered frames are
   * replayed in arrival order the moment the handler is set.
   */
  private dispatchTurnBundle(bundle: InputMsg): void {
    if (this.turnBundleRouted) {
      this.config.onTurnBundle(bundle)
      return
    }
    if (this.pendingTurnBundles.length < PvPClient.MAX_PENDING) {
      this.pendingTurnBundles.push(bundle)
    }
  }

  private dispatchHash(msg: HashMsg): void {
    if (this.hashRouted) {
      this.config.onHash(msg)
      return
    }
    if (this.pendingHashes.length < PvPClient.MAX_PENDING) {
      this.pendingHashes.push(msg)
    }
  }

  /**
   * Merge/override callbacks after construction. The lobby builds the client,
   * then the match loop (PvPGame) takes over the match-phase callbacks
   * (opponent drop/rejoin/forfeit, resync) once a match is live.
   */
  setCallbacks(patch: Partial<PvPClientConfig>): void {
    Object.assign(this.config, patch)
  }

  disconnect(): void {
    this.intentionalClose = true
    this.stopReconnectLoop()
    this.setAutoReconnect(false)
    this.ws?.close()
    this.ws = null
  }

  /** Send an authoritative world snapshot (reconnect resync). */
  sendResync(turn: number, data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind: 'resync', turn, data: toBase64(data) }))
  }

  get playerSlot(): 0 | 1 | null {
    return this.slot
  }

  get playerId(): string {
    return this.config.playerId
  }

  private handleMessage(data: string): void {
    let msg: { kind?: string; data?: string; slot?: 0 | 1; players?: { slot: 0 | 1; name: string }[]; count?: number; graceSec?: number; turn?: number }
    try {
      msg = JSON.parse(data) as typeof msg
    } catch {
      return
    }

    switch (msg.kind) {
      case 'assigned':
        this.slot = msg.slot ?? null
        if (this.slot !== null) this.config.onAssigned(this.slot)
        break
      case 'match_start':
        this.config.onMatchStart(msg.players ?? [])
        break
      case 'player_joined':
        this.config.onPlayerJoined(msg.count ?? 0)
        break
      case 'turn':
      case 'hash': {
        if (!msg.data) return
        const decoded = decodeMessage(fromBase64(msg.data))
        if (decoded.kind === MsgKind.Input) this.dispatchTurnBundle(decoded)
        else if (decoded.kind === MsgKind.Hash) this.dispatchHash(decoded)
        break
      }
      case 'opponent_disconnected':
        this.config.onOpponentDisconnected(msg.graceSec ?? 60)
        break
      case 'opponent_reconnected':
        this.config.onOpponentReconnected?.()
        break
      case 'opponent_forfeited':
        this.config.onOpponentForfeited?.()
        break
      case 'rejoined':
        this.stopReconnectLoop()
        this.config.onRejoined?.()
        break
      case 'resync': {
        if (typeof msg.turn === 'number' && typeof msg.data === 'string') {
          this.config.onResync?.(msg.turn, fromBase64(msg.data))
        }
        break
      }
    }
  }
}

/** Get or create a persistent player ID. */
export function getPlayerId(): string {
  let id: string | null = null
  try {
    id = localStorage.getItem('krts-player-id')
  } catch {
    id = null
  }
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    try {
      localStorage.setItem('krts-player-id', id)
    } catch {
      // ignore (private mode)
    }
  }
  return id
}

/** Get or set player display name. */
export function getPlayerName(): string {
  try {
    return localStorage.getItem('krts-player-name') || 'Player'
  } catch {
    return 'Player'
  }
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem('krts-player-name', name)
  } catch {
    // ignore
  }
}
