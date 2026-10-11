/**
 * PvP Game Integration — bridges the live game loop with lockstep netcode.
 *
 * When a PvP match starts:
 * 1. The AI opponent is disabled (opponent is human)
 * 2. Local commands are queued through LockstepPeer (not applied immediately)
 * 3. The engine advances in lockstep turns (4/sec)
 * 4. Both players' commands are applied deterministically each turn
 */

import { TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import type { Command } from '../session/commands.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnCallbacks } from './turn.ts'
import { WsLink } from './ws-link.ts'
import { applyCommand } from './apply.ts'
import { hashWorldState } from './hash.ts'
import { STEPS_PER_TURN } from './protocol.ts'
import { setStatsMode } from '../data/stats.ts'
import { PvPClient } from './client.ts'
import type { GameComposition } from '../main.ts'

export interface PvPGameConfig {
  composition: GameComposition
  client: PvPClient
  slot: 0 | 1
  onDesync?: (turn: number) => void
  onMatchEnd?: (won: boolean) => void
}

export class PvPGame {
  private composition: GameComposition
  private client: PvPClient
  private link: WsLink
  private peer: LockstepPeer
  private running = false
  private turnTimer: number | null = null
  private onDesync?: (turn: number) => void
  private onMatchEnd?: (won: boolean) => void
  private matchEnded = false

  constructor(config: PvPGameConfig) {
    this.composition = config.composition
    this.client = config.client
    this.onDesync = config.onDesync
    this.onMatchEnd = config.onMatchEnd

    // WebSocket is already reliable + ordered: no retransmit layer needed.
    this.link = new WsLink(
      (msg) => this.client.sendBundle(msg),
      (msg) => this.client.sendHash(msg),
    )

    const callbacks: TurnCallbacks = {
      executeTurn: (turn: number, _step: number, commands: Command[]) => {
        this.executeTurn(turn, commands)
      },
      computeHash: (_turn: number): bigint => {
        return hashWorldState(this.composition.engine.world)
      },
      onRemoteHash: (turn: number, _remote: bigint, _local: bigint, match: boolean) => {
        if (!match) {
          console.error(`DESYNC at turn ${turn}`)
          this.onDesync?.(turn)
        }
      },
      onStall: (turn: number, waitedMs: number) => {
        console.warn(`PvP stall at turn ${turn} (${waitedMs}ms)`)
      },
    }

    this.peer = new LockstepPeer(
      config.slot, // playerIndex (0 or 1)
      2, // peerCount
      this.link,
      callbacks,
    )
  }

  /** Start the PvP match. Disables AI, starts lockstep. */
  start(): void {
    // Pause the Engine's own tick loop — PvPGame drives world.update()
    // via lockstep turns now. Without this the world advances twice.
    this.composition.engine.pause()

    // Standard Battle: fixed tournament stats for symmetric competition.
    // (Kingdom vs Kingdom mode will use base stats + power bands instead.)
    setStatsMode('standard')

    // Route incoming relay frames into the lockstep peer.
    this.client.setTurnBundleHandler((bundle) => this.link.receive(bundle))
    this.client.setHashHandler((msg) => this.link.receive(msg))

    // Freeze the real-time engine loop: in PvP the world must advance ONLY
    // through lockstep turns, or the two clients diverge (double-advance).
    // Rendering continues on its own rAF loop; only sim steps are frozen.
    this.composition.engine.pause()

    // Deferred input: commands emit without mutating the world locally;
    // they take effect when the lockstep turn executes them.
    const localTeam = this.peer.playerIndex === 0 ? TEAM_PLAYER : TEAM_ENEMY
    this.composition.inputController.setLocalTeam(localTeam)
    this.composition.inputController.setDeferredExecution(true)

    // Disable the AI opponent — the human is the opponent now
    const world = this.composition.engine.world
    const opponentIdx = world.systems.indexOf(this.composition.systems.opponent)
    if (opponentIdx !== -1) {
      world.systems.splice(opponentIdx, 1)
    }

    // Queue local commands through lockstep (no immediate local apply).
    this.composition.inputController.setCommandListener((cmd: Command) => {
      this.peer.queueCommand(cmd)
    })

    // Start the turn pump (4 turns/second)
    this.running = true
    this.turnTimer = window.setInterval(() => {
      if (this.running) {
        this.peer.pump(Date.now())
      }
    }, 250) // 1000ms / 4 = 250ms per turn
  }

  /** Stop the PvP match. */
  stop(): void {
    this.running = false
    if (this.turnTimer !== null) {
      clearInterval(this.turnTimer)
      this.turnTimer = null
    }
    // Hand world-stepping back to the Engine.
    this.composition.engine.resume()
    // Restore base stats for single-player / campaign.
    setStatsMode('base')
    // Restore normal single-player input behavior.
    this.composition.inputController.setDeferredExecution(false)
    this.composition.inputController.setLocalTeam(TEAM_PLAYER)
  }

  /** Execute a lockstep turn: apply all commands, step the world. */
  private executeTurn(_turn: number, commands: Command[]): void {
    const world = this.composition.engine.world

    // Apply all commands from both players (pre-ordered deterministically)
    for (const cmd of commands) {
      try {
        applyCommand(world, cmd)
      } catch (err) {
        console.warn('Failed to apply PvP command:', err)
      }
    }

    // Step the world STEPS_PER_TURN times for this turn (1/60s each)
    for (let i = 0; i < STEPS_PER_TURN; i++) {
      world.update(1 / 60)
    }

    // Check for match end (victory system sets world.winner)
    if (!this.matchEnded && world.winner !== -1) {
      this.matchEnded = true
      const won = world.winner === this.peer.playerIndex
      console.log(`PvP match ended: ${won ? 'won' : 'lost'}`)
      this.stop()
      this.onMatchEnd?.(won)
    }
  }

  get currentTurn(): number {
    return this.peer.getCurrentTurn()
  }
}
