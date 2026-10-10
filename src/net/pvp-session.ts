/**
 * PvPSession — wires a live 1v1 match over the Cloudflare relay into the
 * deterministic lockstep simulation.
 *
 * - WsLink adapts the PvPClient's WebSocket frames to the raw-byte interface
 *   LockstepPeer expects (send/onMessage). WebSocket/TCP is already reliable
 *   and ordered, so no extra retransmit layer is needed; the input delay
 *   absorbs latency.
 * - Each lockstep turn executes both players' commands via applyCommand and
 *   then steps the world STEPS_PER_TURN times — the same path the test
 *   harness uses, so determinism guarantees carry over.
 * - State hashes are exchanged every HASH_EVERY_TURNS turns; a mismatch is
 *   reported (desyncs should not happen with identical seeds + inputs).
 */
import { World } from '../core/World.ts'
import { STEPS_PER_TURN, MsgKind, decodeMessage, HASH_EVERY_TURNS } from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'
import { hashWorldState } from './hash.ts'
import { applyCommand } from './apply.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnTransport } from './turn.ts'
import type { Command } from '../session/commands.ts'

/** WsLink adapts the PvPClient's WebSocket frames to the TurnTransport surface. */

/** Fixed sim step: 60 Hz, matching the engine. */
const STEP = 1 / 60

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

/**
 * Adapts raw lockstep bytes to the relay's JSON frames:
 * { kind: 'turn' | 'hash', data: base64 }.
 */
export class WsLink implements TurnTransport {
  onMessage: ((data: Uint8Array) => void) | null = null
  private readonly sendFrame: (kind: 'turn' | 'hash', data: string) => void

  constructor(sendFrame: (kind: 'turn' | 'hash', data: string) => void) {
    this.sendFrame = sendFrame
  }

  send(payload: Uint8Array, _nowMs: number): void {
    const msg = decodeMessage(payload)
    const kind = msg.kind === MsgKind.Input ? 'turn' : 'hash'
    this.sendFrame(kind, toBase64(payload))
  }

  /** Deliver an incoming relay frame to the lockstep peer. */
  receiveFrame(kind: 'turn' | 'hash', data: string): void {
    if (kind !== 'turn' && kind !== 'hash') return
    this.onMessage?.(fromBase64(data))
  }

  /** Deliver pre-decoded wire bytes to the lockstep peer. */
  receive(bytes: Uint8Array): void {
    this.onMessage?.(bytes)
  }
}

export interface PvPSessionEvents {
  onStall?(turn: number, waitedMs: number): void
  onDesync?(turn: number): void
}

/**
 * One side of a live 1v1. Owns the LockstepPeer; the game loop calls pump()
 * every frame and queueCommand() for each local player command.
 */
export class PvPSession {
  private readonly peer: LockstepPeer
  private desyncs = 0
  readonly slot: 0 | 1
  readonly world: World

  constructor(
    slot: 0 | 1,
    world: World,
    link: TurnTransport,
    events: PvPSessionEvents = {},
  ) {
    this.slot = slot
    this.world = world
    this.peer = new LockstepPeer(slot, 2, link, {
      executeTurn: (_turn, _step, commands: Command[]) => {
        for (const c of commands) applyCommand(world, c)
        for (let s = 0; s < STEPS_PER_TURN; s += 1) world.update(STEP)
      },
      computeHash: () => hashWorldState(world),
      onRemoteHash: (turn, _remote, _local, match) => {
        if (!match) {
          this.desyncs += 1
          events.onDesync?.(turn)
        }
      },
      onStall: (turn, waitedMs) => events.onStall?.(turn, waitedMs),
    })
  }

  /** Queue a local player command (executes inputDelay turns from now). */
  queueCommand(cmd: Command): void {
    this.peer.queueCommand(cmd)
  }

  /** Advance the simulation as far as the opponent's inputs allow. */
  pump(nowMs: number): void {
    this.peer.pump(nowMs)
  }

  get currentTurn(): number {
    return this.peer.getCurrentTurn()
  }

  get desyncCount(): number {
    return this.desyncs
  }

  get hashEveryTurns(): number {
    return HASH_EVERY_TURNS
  }
}

/** Re-export for tests. */
export type { InputMsg, HashMsg }
