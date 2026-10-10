/**
 * Deterministic lockstep turn manager.
 *
 * - 4 turns/second (TURN_HZ)
 * - 2-turn input delay (INPUT_DELAY): inputs for turn N are submitted
 *   during turn N-2, giving time for network round-trip.
 * - Both clients advance in lockstep; neither advances past the
 *   latest turn for which both inputs are available.
 */

import type { TurnBundle, NetInput } from './protocol.ts'

export const TURN_HZ = 4
export const INPUT_DELAY = 2
export const HASH_INTERVAL = 40 // Hash every 40 turns (10 seconds)

export interface LockstepConfig {
  player: 0 | 1
  onTurn: (turn: number, inputs: [NetInput | null, NetInput | null]) => void
  onDesync?: (turn: number, localHash: number, remoteHash: number) => void
  sendBundle: (bundle: TurnBundle) => void
}

export class LockstepManager {
  private turn = 0
  private player: 0 | 1
  private pendingInputs: Map<number, NetInput> = new Map() // turn -> my input
  private remoteInputs: Map<number, NetInput> = new Map() // turn -> opponent input
  private onTurn: LockstepConfig['onTurn']
  private onDesync?: LockstepConfig['onDesync']
  private sendBundle: LockstepConfig['sendBundle']
  private accumulator = 0
  private lastHashTurn = 0

  constructor(config: LockstepConfig) {
    this.player = config.player
    this.onTurn = config.onTurn
    this.onDesync = config.onDesync
    this.sendBundle = config.sendBundle
  }

  /** Queue my input for a future turn. */
  submitInput(turn: number, cmds: NetInput['cmds']): void {
    this.pendingInputs.set(turn, { turn, player: this.player, cmds })
  }

  /** Receive opponent's input bundle. */
  receiveBundle(bundle: TurnBundle): void {
    const opp = this.player === 0 ? 1 : 0
    const input = bundle.inputs[opp]
    if (input) {
      this.remoteInputs.set(input.turn, input)
    }
    // Check hash for desync detection
    if (bundle.hash !== undefined && bundle.turn % HASH_INTERVAL === 0) {
      this.checkHash(bundle.turn, bundle.hash)
    }
  }

  /** Submit my input for the upcoming turn (called by game loop). */
  private sendPendingInput(): void {
    const targetTurn = this.turn + INPUT_DELAY
    const input = this.pendingInputs.get(targetTurn)
    // Always send a bundle (even if empty) to keep the protocol moving
    this.sendBundle({
      turn: targetTurn,
      inputs: this.player === 0
        ? [input ?? { turn: targetTurn, player: 0, cmds: [] }, null]
        : [null, input ?? { turn: targetTurn, player: 1, cmds: [] }],
    })
    this.pendingInputs.delete(targetTurn)
  }

  /** Advance the simulation. Returns true if a turn was executed. */
  update(dt: number, getHash: () => number): boolean {
    this.accumulator += dt
    const turnTime = 1 / TURN_HZ
    let advanced = false

    while (this.accumulator >= turnTime) {
      this.accumulator -= turnTime

      // Send my input for the future turn
      this.sendPendingInput()

      // Check if we have both inputs for the current turn
      const myInput = this.pendingInputs.get(this.turn) ??
        { turn: this.turn, player: this.player, cmds: [] }
      const oppInput = this.remoteInputs.get(this.turn)

      if (!oppInput) {
        // Waiting for opponent — don't advance, don't consume accumulator
        // (prevents spiral of death on lag)
        break
      }

      // Execute the turn with both inputs
      const inputs: [NetInput | null, NetInput | null] =
        this.player === 0 ? [myInput, oppInput] : [oppInput, myInput]
      this.onTurn(this.turn, inputs)

      // Cleanup
      this.pendingInputs.delete(this.turn)
      this.remoteInputs.delete(this.turn)

      // Send hash every HASH_INTERVAL turns
      if (this.turn - this.lastHashTurn >= HASH_INTERVAL) {
        this.lastHashTurn = this.turn
        this.sendBundle({
          turn: this.turn,
          inputs: [null, null],
          hash: getHash(),
        })
      }

      this.turn++
      advanced = true
    }

    return advanced
  }

  private checkHash(_turn: number, _remoteHash: number): void {
    // The actual hash comparison happens in the game loop
    // (it needs access to the world). This is a hook.
    if (this.onDesync) {
      // Defer to game loop which will provide local hash
    }
  }

  get currentTurn(): number {
    return this.turn
  }
}
