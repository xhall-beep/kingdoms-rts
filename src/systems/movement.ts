import type { System, World } from '../core/World'
import { HARVEST_OFF, KIND_WORKER, NO_TARGET, STATE_IDLE, STATE_MOVE } from '../core/World'

/**
 * Steering: every entity flagged `moving` walks toward (targetX, targetZ) at
 * moveSpeed and stops within stopDist. Never overshoots the arrival radius.
 * Writes the velocity arrays so the Engine's interpolation keeps working.
 */
export class MovementSystemImpl implements System {
  update(world: World, dt: number): void {
    for (const id of world.entities.keys()) {
      if (world.moving[id] !== 1 || world.moveSpeed[id] <= 0) {
        world.velocityX[id] = 0
        world.velocityZ[id] = 0
        continue
      }
      const dx = world.targetX[id] - world.positionX[id]
      const dz = world.targetZ[id] - world.positionZ[id]
      const dist = Math.hypot(dx, dz)
      // Epsilon: without it, float rounding stalls units exactly at the boundary (Zeno).
      if (dist <= world.stopDist[id] + 1e-4) {
        world.moving[id] = 0
        world.velocityX[id] = 0
        world.velocityZ[id] = 0
        continue
      }
      // dist > stopDist >= 0 here, so dist > 0 and the division is safe.
      const step = Math.min(world.moveSpeed[id] * dt, dist - world.stopDist[id])
      const nx = dx / dist
      const nz = dz / dist
      world.velocityX[id] = nx * world.moveSpeed[id]
      world.velocityZ[id] = nz * world.moveSpeed[id]
      world.positionX[id] += nx * step
      world.positionZ[id] += nz * step
    }
  }
}

/** Order any unit to a point on the map. */
/**
 * Stop a unit: cancel movement, attacks, and other orders.
 * Workers keep HARVEST_OFF (hold position); use Gather to re-arm.
 */
export function orderStop(world: World, id: number): void {
  world.moving[id] = 0
  world.velocityX[id] = 0
  world.velocityZ[id] = 0
  world.targetId[id] = NO_TARGET
  world.state[id] = STATE_IDLE
}

export function orderMove(world: World, id: number, x: number, z: number): void {
  world.targetX[id] = x
  world.targetZ[id] = z
  world.stopDist[id] = 0.5
  world.moving[id] = 1
  world.state[id] = STATE_MOVE
  world.resumeX[id] = NaN
  world.resumeZ[id] = NaN
  // An explicit move order cancels auto-harvest: the worker holds position
  // on arrival instead of walking back to work. The Gather command re-arms it.
  if (world.kind[id] === KIND_WORKER) {
    world.harvestKind[id] = HARVEST_OFF
  }
}
