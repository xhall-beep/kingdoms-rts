import type { System, World } from '../core/World.ts'
import { KIND_SHRINE, KIND_MELEE, KIND_RANGED, KIND_WORKER } from '../core/World.ts'

/**
 * Shrines & Victory Points (v2.0 spec, section 4: anti-stall).
 *
 * A shrine is a neutral capturable objective. When exactly one team holds
 * military presence within the capture radius, that team holds the shrine.
 * Every second, each held shrine drains 5 Victory Points from the enemy.
 * A team reduced to 0 VP loses — turtling forever is not an option.
 *
 * Capture checks run once per second (not per tick): presence barely moves
 * at 60Hz, and the sweep is O(shrines x units).
 */
const CAPTURE_RADIUS = 8
const VP_DRAIN_PER_SHRINE = 5
const CHECK_INTERVAL = 1

function isMilitary(world: World, id: number): boolean {
  const k = world.kind[id]
  return k === KIND_MELEE || k === KIND_RANGED || k === KIND_WORKER
}

export class ShrineSystemImpl implements System {
  private timer = 0

  update(world: World, dt: number): void {
    if (world.winner !== -1) return
    this.timer += dt
    if (this.timer < CHECK_INTERVAL) return
    this.timer = 0

    for (const sid of world.entities.keys()) {
      if (world.kind[sid] !== KIND_SHRINE) continue
      // Count military presence per team within the capture radius.
      let p0 = 0
      let p1 = 0
      const sx = world.positionX[sid]
      const sz = world.positionZ[sid]
      for (const id of world.entities.keys()) {
        if (!isMilitary(world, id) || world.health[id] <= 0) continue
        const dx = world.positionX[id] - sx
        const dz = world.positionZ[id] - sz
        if (dx * dx + dz * dz > CAPTURE_RADIUS * CAPTURE_RADIUS) continue
        if (world.team[id] === 0) p0 += 1
        else p1 += 1
      }
      if (p0 > 0 && p1 === 0) world.shrineHeld[sid] = 0
      else if (p1 > 0 && p0 === 0) world.shrineHeld[sid] = 1
      // Contested or empty: the holder keeps it (no flip-flopping).

      // Drain the enemy's Victory Points.
      const holder = world.shrineHeld[sid]
      if (holder === 0 || holder === 1) {
        const enemy = (1 - holder) as 0 | 1
        world.victoryPoints[enemy] = Math.max(0, world.victoryPoints[enemy] - VP_DRAIN_PER_SHRINE)
      }
    }
  }

  reset(): void {
    this.timer = 0
  }
}
