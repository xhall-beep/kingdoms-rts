/**
 * PvP WebSocket client.
 *
 * Connects to the Cloudflare Worker relay, joins a room via code,
 * and exchanges turn bundles with the opponent.
 */

import type { TurnBundle } from './protocol.ts'

export interface PvPClientConfig {
  serverUrl: string // e.g. "wss://kingdoms-pvp.workers.dev"
  playerId: string
  playerName: string
  onAssigned: (slot: 0 | 1) => void
  onMatchStart: (players: { slot: 0 | 1; name: string }[]) => void
  onTurnBundle: (bundle: TurnBundle) => void
  onOpponentDisconnected: () => void
  onPlayerJoined: (count: number) => void
}

export class PvPClient {
  private ws: WebSocket | null = null
  private config: PvPClientConfig
  private slot: 0 | 1 | null = null

  constructor(config: PvPClientConfig) {
    this.config = config
  }

  /** Create a new room and return the join code. */
  static async createRoom(serverUrl: string): Promise<string> {
    const httpUrl = serverUrl.replace('wss://', 'https://').replace('ws://', 'http://')
    const res = await fetch(`${httpUrl}/api/room/create`, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to create room')
    const data = await res.json() as { code: string }
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

  /** Send a turn bundle to the opponent (via relay). */
  sendBundle(bundle: TurnBundle): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ kind: 'turn', bundle }))
  }

  /** Send a raw message. */
  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
  }

  get playerSlot(): 0 | 1 | null {
    return this.slot
  }

  private handleMessage(data: string): void {
    let msg: any
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }

    switch (msg.kind) {
      case 'assigned':
        this.slot = msg.slot
        this.config.onAssigned(msg.slot)
        break
      case 'match_start':
        this.config.onMatchStart(msg.players)
        break
      case 'player_joined':
        this.config.onPlayerJoined(msg.count)
        break
      case 'turn':
        this.config.onTurnBundle(msg.bundle)
        break
      case 'hash':
        this.config.onTurnBundle({ turn: msg.turn, inputs: [null, null], hash: msg.hash } as any)
        break
      case 'opponent_disconnected':
        this.config.onOpponentDisconnected()
        break
    }
  }
}

/** Get or create a persistent player ID. */
export function getPlayerId(): string {
  let id = localStorage.getItem('krts-player-id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('krts-player-id', id)
  }
  return id
}

/** Get or set player display name. */
export function getPlayerName(): string {
  return localStorage.getItem('krts-player-name') || 'Player'
}

export function setPlayerName(name: string): void {
  localStorage.setItem('krts-player-name', name)
}
