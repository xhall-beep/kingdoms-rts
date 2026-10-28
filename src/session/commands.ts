import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { UpgradeType } from '../data/upgrades.ts'
import type { FactionId } from '../data/factions.ts'

/**
 * Player commands as data. The simulation is deterministic (fixed 60Hz step,
 * no randomness, deterministic AI), so a match is fully described by its
 * initial state plus this ordered command list — the foundation for replays,
 * save files, and future lockstep multiplayer.
 *
 * `step` is the engine simulation step when the command was issued.
 */
export type Command =
  | { type: 'move'; step: number; unitIds: number[]; x: number; z: number }
  | { type: 'attack'; step: number; unitIds: number[]; targetId: number }
  | { type: 'attackmove'; step: number; unitIds: number[]; x: number; z: number }
  | { type: 'gather'; step: number; unitIds: number[]; nodeId: number }
  | {
      type: 'build'
      step: number
      workerId: number
      building: BuildingType
      x: number
      z: number
      siteId: number
    }
  /**
   * Building-targeted commands (train / cancelTrain / rally / upgrade /
   * research) carry the commanding `team` — the way militia and warhorn
   * always did — and the apply paths refuse them when the named
   * building belongs to the other team (ownership validation; without
   * it a tampered PvP client could research / train / cancel / rally /
   * upgrade at an ENEMY building, charging the enemy's treasury —
   * tester H2). `team` is optional in the type only because command
   * logs recorded before the field existed are plain JSON without it:
   * every emitter sets it, the wire codec always carries it, and a
   * missing team applies with historical (unchecked) behavior so old
   * stored logs replay intact.
   */
  | { type: 'train'; step: number; buildingId: number; unit: UnitType; team?: 0 | 1 }
  /** Cancel production: index -1 = active item, >= 0 = queue index. */
  | { type: 'cancelTrain'; step: number; buildingId: number; index: number; team?: 0 | 1 }
  | { type: 'rally'; step: number; buildingId: number; x: number; z: number; team?: 0 | 1 }
  | { type: 'patrol'; step: number; unitIds: number[]; x: number; z: number }
  | { type: 'stop'; step: number; unitIds: number[] }
  | { type: 'hold'; step: number; unitIds: number[] }
  | { type: 'militia'; step: number; team: 0 | 1 }
  | { type: 'upgrade'; step: number; buildingId: number; team?: 0 | 1 }
  /**
   * Research one ladder level at its home building (smithy / archery
   * range). Validation is centralized in researchUpgrade — the apply
   * paths call it, never reimplement it, so both peers (and replays)
   * accept or refuse identically. The apply paths additionally check
   * ownership (the commanding `team` above must own the building):
   * researchUpgrade derives its team FROM the building, so without
   * the check a command naming an enemy smithy researched for the
   * enemy at the enemy's expense (tester H2). Research used to be a
   * direct local call from the HUD: unrecorded (replays silently
   * diverged) and, in a lockstep match, a one-peer mutation of hashed
   * state (desync).
   */
  | { type: 'research'; step: number; buildingId: number; upgrade: UpgradeType; team?: 0 | 1 }
  | { type: 'warhorn'; step: number; team: 0 | 1; rally: 1 | 2 | 3 }
  | { type: 'surrender'; step: number; player: 0 | 1 }
  /**
   * PvP match-opening handshake. Each side declares the faction it will play
   * (slot 0 -> team 0, slot 1 -> team 1). The lockstep barrier guarantees both
   * declarations are present before turn 0 executes, so both peers reseed the
   * world identically. Never recorded to the command log; consumed by the
   * match handshake before commands are applied.
   */
  | { type: 'pvp-setup'; step: number; player: 0 | 1; faction: FactionId }

export class CommandLog {
  private commands: Command[] = []

  record(cmd: Command): void {
    this.commands.push(cmd)
  }

  getCommands(): readonly Command[] {
    return this.commands
  }

  get length(): number {
    return this.commands.length
  }

  clear(): void {
    this.commands.length = 0
  }

  toJSON(): Command[] {
    return this.commands.map((c) => ({ ...c }))
  }

  fromJSON(data: readonly Command[]): void {
    this.commands = data.map((c) => ({ ...c }))
  }
}
