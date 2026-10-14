/**
 * PvP-vs-AI — solo-testable AI opponent running through the real lockstep path.
 *
 * The human plays slot 0; a deterministic OpponentAI plays slot 1. The AI's
 * decisions are emitted as Command objects (via its command sink) and injected
 * into the LockstepPeer as if they arrived from a remote player. This exercises
 * the full PvP flow — turn bundles, applyCommand, hashing, surrender — with no
 * network, no second phone, and no second player.
 *
 * Difficulty mapping (user-facing tiers -> AI tuning):
 *   passive    -> easy   + defender  (turtles, expands, never attacks first)
 *   normal     -> normal + expander  (balanced boom + timed attacks)
 *   aggressive -> hard   + aggressor (rushes with smaller forces)
 */

import { TEAM_ENEMY } from '../core/World.ts'
import type { Command } from '../session/commands.ts'
import { OpponentAI } from '../ai/opponent.ts'
import type { AIDifficulty, AIPersonality } from '../ai/opponent.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnCallbacks, TurnTransport } from './turn.ts'
import { applyCommand } from './apply.ts'
import { hashWorldState } from './hash.ts'
import { STEPS_PER_TURN, encodeMessage, MsgKind } from './protocol.ts'
import { setStatsMode } from '../data/stats.ts'
import type { GameComposition } from '../main.ts'

export type AiPracticeTier = 'passive' | 'normal' | 'aggressive'

const TIER_TUNING: Record<AiPracticeTier, { difficulty: AIDifficulty; personality: AIPersonality; label: string }> = {
  passive: { difficulty: 'easy', personality: 'defender', label: 'Passive AI (turtles)' },
  normal: { difficulty: 'normal', personality: 'expander', label: 'Normal AI (balanced)' },
  aggressive: { difficulty: 'hard', personality: 'aggressor', label: 'Aggressive AI (rushes)' },
}

/**
 * In-memory transport: the human's outbound bundles go nowhere (no network),
 * and AI bundles are injected directly as player 1's turn inputs.
 */
class LoopbackTransport implements TurnTransport {
  onMessage: ((data: Uint8Array) => void) | null = null

  send(_payload: Uint8Array, _nowMs: number): void {
    // No network in practice mode — outbound bundles are intentionally dropped.
    // The peer still records them in sentBundles for turn execution.
  }

  /** Inject AI commands as player 1's bundle for a turn. */
  injectRemote(turn: number, commands: Command[]): void {
    this.onMessage?.(
      encodeMessage({ kind: MsgKind.Input, turn, player: 1, commands }),
    )
  }
}

export interface PvpAiGameConfig {
  composition: GameComposition
  tier: AiPracticeTier
  onMatchEnd?: (won: boolean) => void
}

export class PvpAiGame {
  private composition: GameComposition
  private peer: LockstepPeer
  private transport: LoopbackTransport
  private ai: OpponentAI
  private aiBuffer: Command[] = []
  private running = false
  private turnTimer: number | null = null
  private matchEnded = false
  private onMatchEnd?: (won: boolean) => void
  readonly tierLabel: string

  constructor(config: PvpAiGameConfig) {
    this.composition = config.composition
    this.onMatchEnd = config.onMatchEnd
    const tuning = TIER_TUNING[config.tier]
    this.tierLabel = tuning.label

    this.transport = new LoopbackTransport()

    // AI plays TEAM_ENEMY (slot 1), emitting Commands through the sink.
    this.ai = new OpponentAI(TEAM_ENEMY, tuning.difficulty, tuning.personality)
    this.ai.setCommandSink((cmd: Command) => {
      this.aiBuffer.push(cmd)
    })

    const callbacks: TurnCallbacks = {
      executeTurn: (turn: number, _step: number, commands: Command[]) => {
        this.executeTurn(turn, commands)
      },
      computeHash: (_turn: number): bigint => {
        return hashWorldState(this.composition.engine.world)
      },
      // Solo mode: no remote hash to compare against. Hashing still runs
      // (validating the hash pipeline doesn't crash), but desync detection
      // needs two peers — that's what real PvP is for.
      onRemoteHash: (_turn: number, _remote: bigint, _local: bigint, _match: boolean) => {
        // No-op in practice mode: single peer, nothing to compare against.
      },
      onStall: (turn: number, waitedMs: number) => {
        console.warn(`Practice stall at turn ${turn} (${waitedMs}ms)`)
      },
    }

    // The peer's constructor wires transport.onMessage -> its handleMessage,
    // so injectRemote() delivers AI bundles straight into the peer.
    this.peer = new LockstepPeer(0, 2, this.transport, callbacks)
  }

  /** Start practice mode: disable the live AI system, drive via lockstep. */
  start(): void {
    const world = this.composition.engine.world

    // Remove the directly-mutating AI system — our sink-based AI replaces it.
    const systems = world.systems as unknown[]
    const idx = systems.indexOf(this.composition.systems.opponent)
    if (idx !== -1) systems.splice(idx, 1)

    // Pause the Engine's own tick loop — lockstep drives world.update() now.
    this.composition.engine.pause()

    // Standard Battle stats for symmetric play.
    setStatsMode('standard')

    // Queue human commands through lockstep (no immediate local apply).
    this.composition.inputController.setCommandListener((cmd: Command) => {
      this.peer.queueCommand(cmd)
    })

    // 4 turns/second. Before each pump, let the AI think and inject its
    // commands as player 1's bundle for the next unsent turn.
    this.running = true
    this.turnTimer = window.setInterval(() => {
      if (!this.running) return
      this.thinkAi()
      this.peer.pump(Date.now())
    }, 250)
  }

  /** Run the AI's decision cycle, collecting emitted Commands. */
  private thinkAi(): void {
    const world = this.composition.engine.world
    // 0.25s per turn matches the 4Hz pump; the AI's internal thinkEvery
    // timer throttles actual decisions to its difficulty cadence.
    this.ai.update(world, 0.25)

    if (this.aiBuffer.length > 0) {
      const turn = this.peer.getNextSendTurn()
      this.transport.injectRemote(turn, [...this.aiBuffer])
      this.aiBuffer.length = 0
    } else {
      // Inject an empty bundle so the peer never stalls waiting for player 1.
      const turn = this.peer.getNextSendTurn()
      this.transport.injectRemote(turn, [])
    }
  }

  /** Forfeit: surrender through lockstep so the sim ends identically. */
  surrender(): void {
    if (!this.running || this.matchEnded) return
    this.peer.queueCommand({ type: 'surrender', step: 0, player: 0 })
  }

  /** Stop practice mode and restore single-player. */
  stop(): void {
    this.running = false
    if (this.turnTimer !== null) {
      clearInterval(this.turnTimer)
      this.turnTimer = null
    }
    this.composition.engine.resume()
    setStatsMode('base')
    this.composition.inputController.setDeferredExecution(false)
    // Restore the standard single-player AI system.
    const world = this.composition.engine.world
    const systems = world.systems as unknown[]
    if (!systems.includes(this.composition.systems.opponent)) {
      systems.push(this.composition.systems.opponent)
    }
  }

  private executeTurn(_turn: number, commands: Command[]): void {
    const world = this.composition.engine.world
    for (const cmd of commands) {
      try {
        applyCommand(world, cmd)
      } catch (err) {
        console.warn('Failed to apply practice command:', err)
      }
    }
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      world.update(1 / 60)
    }
    if (!this.matchEnded && world.winner !== -1) {
      this.endMatch(world.winner === 0)
    }
  }

  private endMatch(won: boolean): void {
    if (this.matchEnded) return
    this.matchEnded = true
    console.log(`Practice match ended: ${won ? 'won' : 'lost'}`)
    this.stop()
    this.onMatchEnd?.(won)
  }

  get currentTurn(): number {
    return this.peer.getCurrentTurn()
  }
}
