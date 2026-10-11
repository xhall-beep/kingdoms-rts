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
import { PvPClient } from './client.ts'
import type { GameComposition } from '../main.ts'

export interface PvPGameConfig {
  composition: GameComposition
  client: PvPClient
  slot: 0 | 1
  onDesync?: (turn: number) => void
}

export class PvPGame {
  private composition: GameComposition
  private client: PvPClient
  private link: WsLink
  private peer: LockstepPeer
  private running = false
  private turnTimer: number | null = null
  private onDesync?: (turn: number) => void

  constructor(config: PvPGameConfig) {
    this.composition = config.composition
    this.client = config.client
    this.onDesync = config.onDesync

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
    // Route incoming relay frames into the lockstep peer.
    this.client.setTurnBundleHandler((bundle) => this.link.receive(bundle))
    this.client.setHashHandler((msg) => this.link.receive(msg))

    // Disable the AI opponent — the human is the opponent now
    const world = this.composition.engine.world
    const opponentIdx = world.systems.indexOf(this.composition.systems.opponent)
    if (opponentIdx !== -1) {
      world.systems.splice(opponentIdx, 1)
    }

    // Intercept local commands: queue through lockstep instead of applying immediately
    this.composition.inputController.setCommandListener((cmd: Command) => {
      // Tag the command with our team
      const teamCmd = { ...cmd, team: this.peer.playerIndex === 0 ? TEAM_PLAYER : TEAM_ENEMY }
      this.peer.queueCommand(teamCmd as Command)
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
  }

  get currentTurn(): number {
    return this.peer.getCurrentTurn()
  }
}
