import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
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
  | { type: 'train'; step: number; buildingId: number; unit: UnitType }
  /** Cancel production: index -1 = active item, >= 0 = queue index. */
  | { type: 'cancelTrain'; step: number; buildingId: number; index: number }
  | { type: 'rally'; step: number; buildingId: number; x: number; z: number }
  | { type: 'patrol'; step: number; unitIds: number[]; x: number; z: number }
  | { type: 'stop'; step: number; unitIds: number[] }
  | { type: 'hold'; step: number; unitIds: number[] }
  | { type: 'militia'; step: number; team: 0 | 1 }
  | { type: 'upgrade'; step: number; buildingId: number }
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
