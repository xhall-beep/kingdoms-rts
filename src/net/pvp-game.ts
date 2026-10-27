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
import { snapshotWorld, restoreWorld } from './snapshot.ts'
import { STEPS_PER_TURN } from './protocol.ts'
import { setStatsMode } from '../data/stats.ts'
import { PvPClient } from './client.ts'
import type { GameComposition } from '../main.ts'
import type { WorldSave } from '../session/save-load.ts'
import type { FactionId } from '../data/factions.ts'
import {
  createPvpSetupHandshake,
  notePvpSetupCommand,
  resetWorldForMatch,
  type PvpSetupHandshake,
} from './pvp-setup.ts'

export interface PvPGameConfig {
  composition: GameComposition
  client: PvPClient
  slot: 0 | 1
  /** Pristine boot snapshot: the match reseeds from this, not live state. */
  pristineSave: WorldSave
  /** The faction OUR side plays (declared to the opponent via handshake). */
  ownFaction: FactionId
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
  private readonly pristineSave: WorldSave
  private readonly ownFaction: FactionId
  private readonly setup: PvpSetupHandshake = createPvpSetupHandshake()

  constructor(config: PvPGameConfig) {
    this.composition = config.composition
    this.client = config.client
    this.pristineSave = config.pristineSave
    this.ownFaction = config.ownFaction
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

    // Reconnect grace: if our socket drops mid-match, keep rejoining the
    // same room with the same playerId while the worker holds our slot
    // (~60s). Lobby phase stays manual — this only arms once live.
    this.client.setAutoReconnect(true)
    this.client.setCallbacks({
      onOpponentDisconnected: (graceSec) =>
        this.setStatus(`Opponent disconnected — ${graceSec}s to reconnect…`),
      onOpponentReconnected: () => this.handleOpponentReconnected(),
      onOpponentForfeited: () => this.handleOpponentForfeited(),
      onReconnecting: (attempt) =>
        this.setStatus(`Connection lost — retrying (${attempt})…`),
      onRejoined: () => this.setStatus('Reconnected — resyncing…'),
      onResync: (turn, data) => this.handleResync(turn, data),
      onReconnectFailed: () => {
        // Grace expired with no rejoin: the worker forfeited us and the
        // survivor was awarded the win. End locally as a loss.
        this.setStatus('Could not reconnect — match over.')
        this.endMatch(false)
      },
    })

    // Freeze the real-time engine loop: in PvP the world must advance ONLY
    // through lockstep turns, or the two clients diverge (double-advance).
    // Rendering continues on its own rAF loop; only sim steps are frozen.
    this.composition.engine.pause()

    // Deferred input: commands emit without mutating the world locally;
    // they take effect when the lockstep turn executes them.
    const localTeam = this.peer.playerIndex === 0 ? TEAM_PLAYER : TEAM_ENEMY
    this.composition.inputController.setLocalTeam(localTeam)
    this.composition.inputController.setDeferredExecution(true)
    // Slot 1 plays TEAM_ENEMY whose base is at (40,40); the boot camera sits
    // at (-40,-40), which is unexplored blackness for them. Jump to our base.
    this.composition.inputController.centerOnBase()

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

    // HUD-originated commands (train / cancel / research / militia /
    // tier upgrade / war horn) take the same lockstep path. Without
    // this they applied straight to the local world — a one-peer
    // mutation of hashed state that desynced the next hash check.
    this.composition.hudCommandTransport = (cmd: Command) => {
      this.peer.queueCommand(cmd)
    }

    // Match-opening handshake: declare our faction for our side. The
    // lockstep barrier holds turn 0 until BOTH sides' declarations arrive,
    // at which point executeTurn reseeds both worlds identically. Without
    // this, each phone brought its own divergent single-player state into
    // lockstep and the first hash check cried desync.
    this.peer.queueCommand({
      type: 'pvp-setup',
      step: 0,
      player: this.peer.playerIndex === 1 ? 1 : 0,
      faction: this.ownFaction,
    })

    // Start the turn pump (4 turns/second)
    this.running = true
    this.turnTimer = window.setInterval(() => {
      if (this.running) {
        this.peer.pump(Date.now())
      }
    }, 250) // 1000ms / 4 = 250ms per turn
  }

  /** Forfeit the match: sends a surrender command through lockstep so both simulations end identically. */
  surrender(): void {
    if (!this.running || this.matchEnded) return
    this.peer.queueCommand({ type: 'surrender', step: 0, player: this.peer.playerIndex === 1 ? 1 : 0 })
  }

  /** Stop the PvP match. */
  stop(): void {
    this.running = false
    if (this.turnTimer !== null) {
      clearInterval(this.turnTimer)
      this.turnTimer = null
    }
    // The room is done — no more auto-rejoin, no stale status line.
    this.client.setAutoReconnect(false)
    this.setStatus(null)
    // Hand world-stepping back to the Engine.
    this.composition.engine.resume()
    // Restore base stats for single-player / campaign.
    setStatsMode('base')
    // Restore normal single-player input behavior.
    this.composition.inputController.setDeferredExecution(false)
    this.composition.inputController.setLocalTeam(TEAM_PLAYER)
    // HUD commands apply locally again (see start()).
    this.composition.hudCommandTransport = null
  }

  /** Execute a lockstep turn: apply all commands, step the world. */
  private executeTurn(_turn: number, commands: Command[]): void {
    const world = this.composition.engine.world

    // Match-opening handshake: once both sides' faction declarations are
    // in, reseed the world from the pristine snapshot. Deterministic on
    // both peers (same commands, same order, same snapshot, same seed).
    if (!this.setup.seeded) {
      for (const cmd of commands) {
        if (cmd.type !== 'pvp-setup') continue
        const pair = notePvpSetupCommand(this.setup, cmd)
        if (pair !== null) {
          resetWorldForMatch(world, this.pristineSave, pair)
          console.log(`PvP world seeded: slot0=${pair[0]} slot1=${pair[1]}`)
        }
      }
    }

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

    // Check for match end (victory system sets world.winner; surrender
    // sets it via the lockstep surrender command).
    if (!this.matchEnded && world.winner !== -1) {
      this.endMatch(world.winner === this.peer.playerIndex)
    }
  }

  /** Shared match-end path: natural victory, surrender, or forfeit. */
  private endMatch(won: boolean): void {
    if (this.matchEnded) return
    this.matchEnded = true
    console.log(`PvP match ended: ${won ? 'won' : 'lost'}`)
    this.stop()
    this.onMatchEnd?.(won)
  }

  private setStatus(msg: string | null): void {
    this.composition.hud.setPvpStatus(msg)
  }

  /**
   * We are the survivor: the opponent just rejoined. Ship an authoritative
   * snapshot of our world plus our recent bundles so the rejoiner adopts
   * our state and catches up. Inbox is first-write-wins, so re-sends are
   * harmless even if nothing was lost.
   */
  private handleOpponentReconnected(): void {
    const world = this.composition.engine.world
    const turn = this.peer.getCurrentTurn()
    this.client.sendResync(turn, snapshotWorld(world))
    this.peer.resendUnacked(turn - 8, Date.now())
    this.setStatus(null)
  }

  /**
   * Grace expired with no rejoin: claim the win. The opponent is gone, so
   * no lockstep command is needed — endMatch reuses the normal path, and
   * the guard keeps it idempotent if a natural result already landed.
   */
  private handleOpponentForfeited(): void {
    this.setStatus(null)
    this.endMatch(true)
  }

  /**
   * We are the rejoiner: adopt the survivor's snapshot, jump the lockstep
   * clock to its turn, and push our recorded bundles for that window so
   * the survivor isn't left waiting on inputs we already made.
   */
  private handleResync(turn: number, data: Uint8Array): void {
    const world = this.composition.engine.world
    restoreWorld(world, data)
    this.peer.setTurn(turn)
    this.peer.resendUnacked(turn - 8, Date.now())
    this.setStatus(null)
  }

  get currentTurn(): number {
    return this.peer.getCurrentTurn()
  }
}
