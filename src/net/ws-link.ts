/**
 * WsLink — adapts the PvPClient's WebSocket frames to the TurnTransport
 * surface LockstepPeer expects.
 *
 * WebSocket/TCP already gives reliable, ordered delivery, so no extra
 * retransmit layer is needed; the input delay absorbs latency. Outgoing
 * lockstep payloads are decoded once to route them through the client's
 * typed senders; incoming typed messages are re-encoded to raw bytes for
 * the peer.
 */
import { MsgKind, encodeMessage, decodeMessage } from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'
import type { TurnTransport } from './turn.ts'

export class WsLink implements TurnTransport {
  onMessage: ((data: Uint8Array) => void) | null = null
  private readonly sendTurn: (msg: InputMsg) => void
  private readonly sendHash: (msg: HashMsg) => void

  constructor(sendTurn: (msg: InputMsg) => void, sendHash: (msg: HashMsg) => void) {
    this.sendTurn = sendTurn
    this.sendHash = sendHash
  }

  send(payload: Uint8Array, _nowMs: number): void {
    const msg = decodeMessage(payload)
    if (msg.kind === MsgKind.Input) this.sendTurn(msg)
    else if (msg.kind === MsgKind.Hash) this.sendHash(msg)
  }

  /** Deliver an incoming typed relay message to the lockstep peer. */
  receive(msg: InputMsg | HashMsg): void {
    this.onMessage?.(encodeMessage(msg))
  }
}
