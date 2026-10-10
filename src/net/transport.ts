/**
 * Transports for lockstep: an unreliable packet interface, a zero-cost
 * loopback, a seeded simulated network (latency / jitter / loss / reorder),
 * and a reliable ordered channel (seq + cumulative ack + retransmit) on top.
 *
 * Phase 1 uses LoopbackTransport (proving the protocol) and SimulatedNetwork
 * (proving it under adverse conditions). Phase 2 swaps in a WebSocket
 * transport implementing the same UnreliableTransport interface — the
 * ReliableLink and everything above it stays untouched.
 *
 * All timing is virtual (nowMs passed in) so tests are fully deterministic.
 */
import { SeededRandom } from '../core/Math.ts'

export type PeerId = number

/** Minimal unreliable packet delivery. */
export interface UnreliableTransport {
  send(from: PeerId, to: PeerId, data: Uint8Array): void
  setReceiver(cb: (from: PeerId, data: Uint8Array) => void): void
  pump(nowMs: number): void
  /** Bytes sent (for bandwidth profiling). */
  readonly bytesSent: number
}

/** Zero-latency, lossless delivery (queued to avoid reentrancy). */
export class LoopbackTransport implements UnreliableTransport {
  private receiver: ((from: PeerId, data: Uint8Array) => void) | null = null
  private pending: { from: PeerId; to: PeerId; data: Uint8Array }[] = []
  bytesSent = 0

  setReceiver(cb: (from: PeerId, data: Uint8Array) => void): void {
    this.receiver = cb
  }

  send(from: PeerId, to: PeerId, data: Uint8Array): void {
    this.bytesSent += data.byteLength
    this.pending.push({ from, to, data })
  }

  pump(_nowMs: number): void {
    const batch = this.pending
    this.pending = []
    for (const p of batch) this.receiver?.(p.from, p.data)
  }
}

export interface NetProfile {
  /** Base one-way latency in ms. */
  latencyMs: number
  /** Uniform jitter added on top (±ms). */
  jitterMs: number
  /** Packet loss probability in [0, 1). */
  loss: number
  /** Chance a packet is delayed an extra 2× latency (causes reordering). */
  reorder: number
}

export const NET_PERFECT: NetProfile = { latencyMs: 0, jitterMs: 0, loss: 0, reorder: 0 }
export const NET_LAN: NetProfile = { latencyMs: 5, jitterMs: 2, loss: 0, reorder: 0 }
export const NET_WIFI: NetProfile = { latencyMs: 25, jitterMs: 10, loss: 0.005, reorder: 0.01 }
export const NET_LTE: NetProfile = { latencyMs: 70, jitterMs: 25, loss: 0.02, reorder: 0.03 }
export const NET_BAD: NetProfile = { latencyMs: 200, jitterMs: 60, loss: 0.05, reorder: 0.05 }

interface QueuedPacket {
  deliverAt: number
  from: PeerId
  to: PeerId
  data: Uint8Array
}

/**
 * Seeded adverse network. Deterministic given the seed: the same test run
 * produces the same drop/delay pattern, so failures are reproducible.
 */
export class SimulatedNetwork implements UnreliableTransport {
  private receiver: ((from: PeerId, data: Uint8Array) => void) | null = null
  private queue: QueuedPacket[] = []
  private nowMs = 0
  bytesSent = 0
  dropped = 0
  delivered = 0

  private readonly rng: SeededRandom
  private readonly profile: NetProfile

  constructor(rng: SeededRandom, profile: NetProfile) {
    this.rng = rng
    this.profile = profile
  }

  setReceiver(cb: (from: PeerId, data: Uint8Array) => void): void {
    this.receiver = cb
  }

  send(from: PeerId, to: PeerId, data: Uint8Array): void {
    this.bytesSent += data.byteLength
    if (this.rng.next() < this.profile.loss) {
      this.dropped += 1
      return
    }
    let delay =
      this.profile.latencyMs + (this.rng.next() * 2 - 1) * this.profile.jitterMs
    if (delay < 0) delay = 0
    if (this.rng.next() < this.profile.reorder) delay += this.profile.latencyMs * 2
    this.queue.push({ deliverAt: this.nowMs + delay, from, to, data })
  }

  pump(nowMs: number): void {
    this.nowMs = nowMs
    // Stable sort keeps same-timestamp order deterministic.
    this.queue.sort((a, b) => a.deliverAt - b.deliverAt)
    let i = 0
    while (i < this.queue.length && this.queue[i].deliverAt <= nowMs) i += 1
    const due = this.queue.splice(0, i)
    for (const p of due) {
      this.delivered += 1
      this.receiver?.(p.from, p.data)
    }
  }
}

const RELIABLE_HEADER = 8 // seq u32 + cumulative-ack u32
const RETRANSMIT_MS = 120

/**
 * Reliable in-order delivery over an UnreliableTransport.
 * Packet: [seq:u32][ack:u32][payload]. Cumulative acks, out-of-order
 * buffering, retransmit after RETRANSMIT_MS without ack. Pure-ack packets
 * carry an empty payload.
 */
export class ReliableLink {
  /** Called with payloads in send order. */
  onMessage: ((data: Uint8Array) => void) | null = null
  /** Smoothed RTT estimate (ms), for adaptive input delay in phase 2. */
  rttMs = 0

  private sendSeq = 0
  private recvNext = 0
  private readonly unacked = new Map<number, { packet: Uint8Array; sentAt: number }>()
  private readonly ooo = new Map<number, Uint8Array>()

  private readonly net: UnreliableTransport
  private readonly localId: PeerId
  private readonly remoteId: PeerId

  constructor(net: UnreliableTransport, localId: PeerId, remoteId: PeerId) {
    this.net = net
    this.localId = localId
    this.remoteId = remoteId
  }

  /** Wire two links through one shared net (phase-1 harness). */
  static wire(net: UnreliableTransport, linkAB: ReliableLink, linkBA: ReliableLink): void {
    net.setReceiver((from, data) => {
      if (from === linkAB.localId) linkBA.handlePacket(data, 0)
      else linkAB.handlePacket(data, 0)
    })
  }

  send(payload: Uint8Array, nowMs: number): void {
    const seq = this.sendSeq
    this.sendSeq = (this.sendSeq + 1) >>> 0
    const packet = new Uint8Array(RELIABLE_HEADER + payload.byteLength)
    const view = new DataView(packet.buffer)
    view.setUint32(0, seq, true)
    view.setUint32(4, this.cumulativeAck(), true)
    packet.set(payload, RELIABLE_HEADER)
    this.unacked.set(seq, { packet, sentAt: -1 })
    this.flush(nowMs)
  }

  /** Packets awaiting ack (backpressure signal). */
  get inflight(): number {
    return this.unacked.size
  }

  pump(nowMs: number): void {
    this.flush(nowMs)
  }

  /** Highest contiguously-received seq is recvNext-1; ack carries recvNext ("expecting"). */
  private cumulativeAck(): number {
    return this.recvNext >>> 0
  }

  private flush(nowMs: number): void {
    for (const e of this.unacked.values()) {
      if (e.sentAt < 0 || nowMs - e.sentAt >= RETRANSMIT_MS) {
        e.sentAt = nowMs
        new DataView(e.packet.buffer).setUint32(4, this.cumulativeAck(), true)
        this.net.send(this.localId, this.remoteId, e.packet)
      }
    }
  }

  private handlePacket(packet: Uint8Array, nowMs: number): void {
    if (packet.byteLength < RELIABLE_HEADER) return
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    const seq = view.getUint32(0, true)
    const ack = view.getUint32(4, true)

    // Cumulative ack: `ack` = next expected seq; everything before it is acked.
    for (const s of [...this.unacked.keys()]) {
      if (((ack - s - 1) >>> 0) < 0x80000000) {
        const e = this.unacked.get(s)
        if (e && e.sentAt >= 0 && nowMs > 0) {
          const sample = nowMs - e.sentAt
          this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.8 + sample * 0.2
        }
        this.unacked.delete(s)
      }
    }

    const payload = packet.slice(RELIABLE_HEADER)
    if (payload.byteLength === 0) return // pure ack

    if (seq === this.recvNext) {
      this.recvNext = (this.recvNext + 1) >>> 0
      this.onMessage?.(payload)
      while (this.ooo.has(this.recvNext)) {
        const p = this.ooo.get(this.recvNext) as Uint8Array
        this.ooo.delete(this.recvNext)
        this.recvNext = (this.recvNext + 1) >>> 0
        this.onMessage?.(p)
      }
    } else if (((seq - this.recvNext) >>> 0) < 0x80000000) {
      this.ooo.set(seq, payload) // future packet: buffer
    }
    // else: duplicate — already delivered, ignore.

    this.sendAck()
  }

  private sendAck(): void {
    const packet = new Uint8Array(RELIABLE_HEADER)
    const view = new DataView(packet.buffer)
    view.setUint32(0, 0xffffffff, true) // marker: not a data seq
    view.setUint32(4, this.cumulativeAck(), true)
    this.net.send(this.localId, this.remoteId, packet)
  }
}
