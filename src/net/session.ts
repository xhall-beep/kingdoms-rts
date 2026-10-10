/**
 * LockstepSession — the Phase-1 harness: two (or N) peers, each with its own
 * World, exchanging real wire-protocol messages through a real
 * ReliableLink over a (possibly adverse) simulated network, all on virtual
 * time. This is "two sims in one page" with zero server.
 *
 * The session drives scripted players, steps both simulations in lockstep,
 * exchanges state hashes, detects desyncs, and auto-resyncs from snapshots.
 * The report proves (or disproves) determinism over the wire.
 */
import { World } from '../core/World.ts'
import { makeWorld, STEP } from '../tests/setup.ts'
import { STEPS_PER_TURN, HASH_EVERY_TURNS } from './protocol.ts'
import { hashWorldState, hashToHex } from './hash.ts'
import { snapshotWorld, restoreWorld } from './snapshot.ts'
import {
  SimulatedNetwork,
  LoopbackTransport,
  ReliableLink,
  NET_PERFECT,
} from './transport.ts'
import type { NetProfile, UnreliableTransport } from './transport.ts'
import { LockstepPeer } from './turn.ts'
import { applyCommand } from './apply.ts'
import { ScriptedDriver } from './driver.ts'
import { SeededRandom } from '../core/Math.ts'
import type { Command } from '../session/commands.ts'

export interface SessionConfig {
  /** Number of lockstep turns to run (4 turns = 1 sim-second). */
  turns: number
  /** Network adversity profile. */
  net: NetProfile
  /** Seed for the simulated network RNG (reproducible adversity). */
  netSeed?: number
  /** Input delay in turns. */
  inputDelayTurns?: number
  /** Virtual-time step in ms. */
  tickMs?: number
}

export interface SessionReport {
  turnsExecuted: number
  simSteps: number
  hashesCompared: number
  desyncs: number
  resyncs: number
  stalls: number
  maxStallMs: number
  /** Total wire bytes per peer (game messages only). */
  bytesPerPeer: number[]
  /** Transport-level bytes (incl. reliability overhead) + drops. */
  transportBytes: number
  transportDropped: number
  /** Simulated minutes of game time. */
  simMinutes: number
  /** Bytes per sim-minute per player (bandwidth profile). */
  bytesPerMinute: number
  desyncLog: string[]
}

interface PeerCtx {
  peer: LockstepPeer
  world: World
  driver: ScriptedDriver
  link: ReliableLink
  lastDriverTurn: number
}

/** A live, steppable lockstep session (drives demos and tests). */
export interface LiveSession {
  /** Advance virtual time by tickMs and pump everything once. */
  tick(): void
  nowMs: number
  worlds: World[]
  peers: LockstepPeer[]
  getReport(): SessionReport
  /** Corrupt a peer's world (fault injection for resync demos/tests). */
  corruptPeer(index: number): void
}

export function createLockstepSession(config: SessionConfig): LiveSession {
  const tickMs = config.tickMs ?? 5
  const rng = new SeededRandom(config.netSeed ?? 0xc10c4)
  const net: UnreliableTransport =
    config.net === NET_PERFECT
      ? new LoopbackTransport()
      : new SimulatedNetwork(rng, config.net)

  const report: SessionReport = {
    turnsExecuted: 0,
    simSteps: 0,
    hashesCompared: 0,
    desyncs: 0,
    resyncs: 0,
    stalls: 0,
    maxStallMs: 0,
    bytesPerPeer: [0, 0],
    transportBytes: 0,
    transportDropped: 0,
    simMinutes: 0,
    bytesPerMinute: 0,
    desyncLog: [],
  }

  const peers: PeerCtx[] = []
  const links: ReliableLink[] = []
  const desyncTurns = new Set<number>()
  const resyncedTurns = new Set<number>()
  for (let p = 0; p < 2; p += 1) {
    const world = makeWorld()
    const link = new ReliableLink(net, p, 1 - p)
    links.push(link)
    const driver = new ScriptedDriver(p)
    const ctx: PeerCtx = {
      peer: null as unknown as LockstepPeer,
      world,
      driver,
      link,
      lastDriverTurn: -1,
    }
    const peer = new LockstepPeer(p, 2, link, {
      executeTurn: (_turn: number, _step: number, commands: Command[]) => {
        for (const c of commands) applyCommand(world, c)
        for (let s = 0; s < STEPS_PER_TURN; s += 1) world.update(STEP)
      },
      computeHash: () => hashWorldState(world),
      onRemoteHash: (turn, remote, local, match) => {
        report.hashesCompared += 1
        if (!match) {
          // Count each divergent turn once (both peers report it; either
          // may report first).
          if (!desyncTurns.has(turn)) {
            desyncTurns.add(turn)
            report.desyncs += 1
            report.desyncLog.push(
              `DESYNC turn ${turn}: local ${hashToHex(local)} remote ${hashToHex(remote)}`,
            )
          }
          // Peer 1 resyncs on every mismatch it sees (independent of who
          // counted it): adopt peer 0's current state AND turn
          // (deterministic rule). Same bundles re-execute deterministically,
          // so both peers re-converge; the next hash exchange re-verifies.
          if (p === 1 && !resyncedTurns.has(turn)) {
            resyncedTurns.add(turn)
            const bytes = snapshotWorld(peers[0].world)
            restoreWorld(world, bytes)
            peer.setTurn(peers[0].peer.getCurrentTurn())
            report.resyncs += 1
          }
        }
      },
      onStall: (_turn: number, waitedMs: number) => {
        report.stalls += 1
        if (waitedMs > report.maxStallMs) report.maxStallMs = waitedMs
      },
    }, { inputDelayTurns: config.inputDelayTurns })
    ctx.peer = peer
    ctx.peer.setTurnLimit(config.turns)
    peers.push(ctx)
  }
  ReliableLink.wire(net, links[0], links[1])

  let nowMs = 0
  const session: LiveSession = {
    nowMs: 0,
    worlds: peers.map((c) => c.world),
    peers: peers.map((c) => c.peer),
    tick: () => {
      nowMs += tickMs
      session.nowMs = nowMs
      // Drivers queue inputs for upcoming turns (once per turn).
      for (const ctx of peers) {
        const upcoming = ctx.peer.getCurrentTurn() + 2
        if (upcoming > ctx.lastDriverTurn) {
          ctx.lastDriverTurn = upcoming
          for (const cmd of ctx.driver.commandsForTurn(ctx.world, upcoming)) {
            ctx.peer.queueCommand(cmd)
          }
        }
      }
      net.pump(nowMs)
      for (const ctx of peers) {
        ctx.link.pump(nowMs)
        ctx.peer.pump(nowMs)
      }
    },
    getReport: () => {
      // Conservative: report the minimum turn across peers.
      report.turnsExecuted = Math.min(...peers.map((c) => c.peer.getCurrentTurn()))
      report.simSteps = report.turnsExecuted * STEPS_PER_TURN
      report.simMinutes = report.simSteps / 60 / 60
      report.bytesPerPeer = peers.map((c) => c.peer.bytesOut)
      report.transportBytes = net.bytesSent
      if (net instanceof SimulatedNetwork) report.transportDropped = net.dropped
      const totalGameBytes = report.bytesPerPeer[0] + report.bytesPerPeer[1]
      report.bytesPerMinute =
        report.simMinutes > 0 ? totalGameBytes / 2 / report.simMinutes : 0
      return report
    },
    corruptPeer: (index: number) => {
      // Flip a unit's position: guaranteed state divergence.
      const w = peers[index].world
      w.positionX[5] += 37.5
    },
  }
  return session
}

export function runLockstepMatch(config: SessionConfig): SessionReport {
  const session = createLockstepSession(config)
  const tickMs = config.tickMs ?? 5
  const totalMs = (config.turns / 4) * 1000
  let guard = 0
  const maxGuard = totalMs / tickMs + 100000
  // Wait for ALL peers (a resync can leave one peer briefly behind).
  const allDone = (): boolean =>
    session.peers.every((p) => p.getCurrentTurn() >= config.turns)
  while (!allDone() && guard < maxGuard) {
    guard += 1
    session.tick()
  }
  return session.getReport()
}

/** Re-export for tests that build custom sessions. */
export { HASH_EVERY_TURNS }
