import type { System, World } from '../core/World'
import { KIND_FARM } from '../core/World'

/**
 * Victory detection. A team is eliminated when it controls no units and no
 * buildings (trees and gold mines are neutral and don't count). Checked every
 * half second; sets world.winner once and then stays out of the way.
 */
export class VictorySystemImpl implements System {
  private timer = 0

  /** Internal check timer is sim state (lockstep snapshot/hash). */
  getTimer(): number {
    return this.timer
  }

  setTimer(t: number): void {
    this.timer = t
  }

  update(world: World, dt: number): void {
    if (world.winner !== -1) return
    this.timer += dt
    if (this.timer < 0.5) return
    this.timer = 0

    const alive0 = this.teamAlive(world, 0)
    const alive1 = this.teamAlive(world, 1)
    if (!alive0 && !alive1) {
      // Mutual annihilation: the player held out, call it a draw for team 0.
      world.winner = 0
    } else if (!alive1) {
      world.winner = 0
    } else if (!alive0) {
      world.winner = 1
    }
  }

  private teamAlive(world: World, team: 0 | 1): boolean {
    for (const id of world.entities.keys()) {
      if (world.team[id] !== team) continue
      if (world.health[id] <= 0) continue
      const kind = world.kind[id]
      // Units (0-2) and buildings (3-6) count; resources don't.
      if (kind <= KIND_FARM) return true
    }
    return false
  }

  /** Reset for a fresh match. */
  reset(): void {
    this.timer = 0
  }
}
