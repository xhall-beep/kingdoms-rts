/**
 * Deterministic lockstep turn manager (one per local player).
 *
 * Protocol:
 * - Time is divided into turns (TURN_HZ per second, STEPS_PER_TURN sim steps).
 * - At the start of turn T, the peer broadcasts its input bundle for turn
 *   T + inputDelay (local inputs collected since the last turn).
 * - Turn T executes when bundles for turn T have arrived from ALL peers.
 *   Commands execute in deterministic order: player 0's first (in queued
 *   order), then player 1's, etc. Each command is stamped with
 *   step = turn * STEPS_PER_TURN.
 * - Every HASH_EVERY_TURNS turns, peers exchange state hashes for desync
 *   detection.
 * - If a turn can't execute within stallWarnMs, onStall fires (UI shows
 *   "waiting for opponent"); the sim never advances without all inputs.
 */
import type { Command } from '../session/commands.ts'
import { MsgKind, encodeMessage, decodeMessage } from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'
import { STEPS_PER_TURN, DEFAULT_INPUT_DELAY_TURNS, HASH_EVERY_TURNS } from './protocol.ts'

export interface LockstepConfig {
  /** Turns per second (default TURN_HZ). */
  turnHz?: number
  /** Input delay in turns (default 2). */
  inputDelayTurns?: number
  /** Hash exchange cadence in turns (default HASH_EVERY_TURNS). */
  hashEveryTurns?: number
  /** Ms without progress before onStall fires. */
  stallWarnMs?: number
}

export interface TurnCallbacks {
  /** Execute one turn: commands are pre-ordered deterministically. */
  executeTurn(turn: number, step: number, commands: Command[]): void
  /** Compute the state hash AFTER executing `turn`. */
  computeHash(turn: number): bigint
  /** A remote hash arrived; `match` says whether it equals ours. */
  onRemoteHash(turn: number, remote: bigint, local: bigint, match: boolean): void
  onStall?(turn: number, waitedMs: number): void
}

export interface PumpStats {
  executed: number
  stalled: boolean
  currentTurn: number
}

/**
 * Minimal transport surface the lockstep peer needs. ReliableLink satisfies
 * this; so does the WebSocket adapter used for live PvP (TCP already gives
 * us reliable, ordered delivery).
 */
export interface TurnTransport {
  onMessage: ((data: Uint8Array) => void) | null
  send(payload: Uint8Array, nowMs: number): void
}

export class LockstepPeer {
  readonly playerIndex: number
  readonly peerCount: number

  private readonly inputDelay: number
  private readonly hashEvery: number
  private readonly stallWarnMs: number
  private readonly link: TurnTransport
  private readonly cb: TurnCallbacks

  private turn = 0
  private sentUpTo = -1
  /** Optional cap: stop executing turns at this limit (test harness). */
  private turnLimit = Number.POSITIVE_INFINITY
  /** Bundles WE sent, by turn (kept for execution). */
  private readonly sentBundles = new Map<number, Command[]>()
  /** Bundles received FROM each remote peer, by turn. */
  private readonly inbox = new Map<number, Map<number, Command[]>>()
  /** Local inputs queued since the last turn boundary. */
  private localQueue: Command[] = []
  /** Our hashes awaiting the remote's (turn -> hash). */
  private readonly pendingHashes = new Map<number, bigint>()
  private lastProgressMs = 0
  private stallFiredForTurn = -1
  bytesOut = 0
  bytesIn = 0

  constructor(
    playerIndex: number,
    peerCount: number,
    link: TurnTransport,
    cb: TurnCallbacks,
    config: LockstepConfig = {},
  ) {
    this.playerIndex = playerIndex
    this.peerCount = peerCount
    this.link = link
    this.cb = cb
    this.inputDelay = config.inputDelayTurns ?? DEFAULT_INPUT_DELAY_TURNS
    this.hashEvery = config.hashEveryTurns ?? HASH_EVERY_TURNS
    this.stallWarnMs = config.stallWarnMs ?? 2000
    link.onMessage = (data) => this.handleMessage(data)
  }

  /** Queue a local player command (executed inputDelay turns from now). */
  queueCommand(cmd: Command): void {
    this.localQueue.push(cmd)
  }

  getCurrentTurn(): number {
    return this.turn
  }

  /** Stop executing turns once `turn` reaches `limit` (test harness). */
  setTurnLimit(limit: number): void {
    this.turnLimit = limit
  }

  /**
   * Reset the turn counter (desync resync). Bundles already exchanged for
   * turns >= the new value are retained and re-executed deterministically.
   */
  setTurn(turn: number): void {
    this.turn = turn
    this.lastProgressMs = 0
    this.stallFiredForTurn = -1
  }

  private sendBundle(forTurn: number, nowMs: number): void {
    // The local queue is consumed by the next unsent turn: inputs are
    // scheduled inputDelay turns ahead, giving the network time to deliver.
    const bundle = [...this.localQueue]
    this.localQueue = []
    this.sentBundles.set(forTurn, bundle)
    const msg = encodeMessage({
      kind: MsgKind.Input,
      turn: forTurn,
      player: this.playerIndex,
      commands: bundle,
    })
    this.bytesOut += msg.byteLength
    this.link.send(msg, nowMs)
  }

  private handleMessage(data: Uint8Array): void {
    this.bytesIn += data.byteLength
    const msg = decodeMessage(data)
    switch (msg.kind) {
      case MsgKind.Input: {
        const m = msg as InputMsg
        if (m.player === this.playerIndex) return // ignore our own echo
        let byTurn = this.inbox.get(m.player)
        if (!byTurn) {
          byTurn = new Map()
          this.inbox.set(m.player, byTurn)
        }
        if (!byTurn.has(m.turn)) byTurn.set(m.turn, m.commands)
        break
      }
      case MsgKind.Hash: {
        const m = msg as HashMsg
        const local = this.pendingHashes.get(m.turn)
        if (local !== undefined) {
          this.pendingHashes.delete(m.turn)
          this.cb.onRemoteHash(m.turn, m.hash, local, m.hash === local)
        }
        break
      }
      default:
        break // Hello/Ping/Pong/Bye/Snapshot handled by the session layer
    }
  }

  private sendHash(turn: number, nowMs: number): void {
    const hash = this.cb.computeHash(turn)
    this.pendingHashes.set(turn, hash)
    const msg = encodeMessage({ kind: MsgKind.Hash, turn, hash })
    this.bytesOut += msg.byteLength
    this.link.send(msg, nowMs)
  }

  private haveAllBundles(turn: number): boolean {
    if (!this.sentBundles.has(turn)) return false
    for (let p = 0; p < this.peerCount; p += 1) {
      if (p === this.playerIndex) continue
      if (!this.inbox.get(p)?.has(turn)) return false
    }
    return true
  }

  /**
   * Advance the simulation as far as inputs allow.
   * Returns turns executed and whether we're stalled waiting on a peer.
   */
  pump(nowMs: number): PumpStats {
    if (this.lastProgressMs === 0) this.lastProgressMs = nowMs

    // Keep the send pipeline full: always have bundles in flight for the
    // next `inputDelay` turns.
    while (this.sentUpTo < this.turn + this.inputDelay) {
      this.sentUpTo += 1
      this.sendBundle(this.sentUpTo, nowMs)
    }

    let executed = 0
    while (this.turn < this.turnLimit && this.haveAllBundles(this.turn)) {
      // Deterministic merge: player 0's commands first (queued order), then 1...
      const merged: Command[] = []
      for (let p = 0; p < this.peerCount; p += 1) {
        const cmds =
          p === this.playerIndex
            ? this.sentBundles.get(this.turn) ?? []
            : this.inbox.get(p)?.get(this.turn) ?? []
        for (const c of cmds) merged.push({ ...c, step: this.turn * STEPS_PER_TURN })
      }
      const step = this.turn * STEPS_PER_TURN
      this.cb.executeTurn(this.turn, step, merged)
      if (this.turn % this.hashEvery === 0) this.sendHash(this.turn, nowMs)
      // Free old bundles (keep a small window for potential resync).
      if (this.turn > 8) {
        this.sentBundles.delete(this.turn - 8)
        for (const byTurn of this.inbox.values()) byTurn.delete(this.turn - 8)
      }
      this.turn += 1
      executed += 1
      this.lastProgressMs = nowMs
      this.stallFiredForTurn = -1
    }

    const waitedMs = nowMs - this.lastProgressMs
    const stalled = executed === 0 && waitedMs >= this.stallWarnMs
    if (stalled && this.stallFiredForTurn !== this.turn) {
      this.stallFiredForTurn = this.turn
      this.cb.onStall?.(this.turn, waitedMs)
    }
    return { executed, stalled, currentTurn: this.turn }
  }
}
