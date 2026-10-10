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
  onOpponentDisconnected: () => void
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
  private readonly config: PvPClientConfig
  private slot: 0 | 1 | null = null

  constructor(config: PvPClientConfig) {
    this.config = config
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
    const { serverUrl, playerId, playerName } = this.config
    const wsUrl = `${serverUrl}/api/room/${code}/ws?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(playerName)}`
    this.ws = new WebSocket(wsUrl)

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string)
    }

    this.ws.onclose = () => {
      // Connection closed — game loop handles reconnect
    }
  }

  /** Send an input bundle to the opponent (via relay). */
  sendBundle(bundle: InputMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind: 'turn', data: toBase64(encodeMessage(bundle)) }))
  }

  /** Send pre-encoded wire bytes as a relay frame (lockstep adapter). */
  sendRaw(kind: 'turn' | 'hash', base64Data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind, data: base64Data }))
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

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  get playerSlot(): 0 | 1 | null {
    return this.slot
  }

  private handleMessage(data: string): void {
    let msg: { kind?: string; data?: string; slot?: 0 | 1; players?: { slot: 0 | 1; name: string }[]; count?: number }
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
        if (decoded.kind === MsgKind.Input) this.config.onTurnBundle(decoded)
        else if (decoded.kind === MsgKind.Hash) this.config.onHash(decoded)
        break
      }
      case 'opponent_disconnected':
        this.config.onOpponentDisconnected()
        break
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
