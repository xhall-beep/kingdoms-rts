import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'

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
