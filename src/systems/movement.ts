import type { System, World } from '../core/World'
import { KIND_TREE } from '../core/World'
import { SpatialHash } from '../core/spatial-hash.ts'
import { FACTIONS } from '../data/factions.ts'
import { rallySpeedMult } from './warhorn.ts'
import { seasonSpeedMult } from './season.ts'
import { HARVEST_OFF, KIND_WORKER, NO_TARGET, STATE_IDLE, STATE_MOVE , STATE_PATROL, STATE_HOLD} from '../core/World'

/**
 * Steering: every entity flagged `moving` walks toward (targetX, targetZ) at
 * moveSpeed and stops within stopDist. Never overshoots the arrival radius.
 * Writes the velocity arrays so the Engine's interpolation keeps working.
 */
/**
 * Elf signature: woodland speed bonus when near trees.
 * Deterministic: spatial hash in world order; first tree found wins.
 */
function getEffectiveSpeed(world: World, id: number, hash: SpatialHash): number {
  const base = world.moveSpeed[id]
  const team = world.team[id] as 0 | 1
  // War Horn: Gale March quickens the army's stride.
  const rally = rallySpeedMult(world, team)
  // Season Wheel: snow slows every stride once winter turns.
  const pace = rally * seasonSpeedMult(world)
  const woodland = FACTIONS[world.factionOfTeam[team]].signature?.woodland
  if (!woodland) return base * pace

  // Check if near any tree (cell 24 > treeRadius 8, so 3x3 covers it)
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const r2 = woodland.treeRadius * woodland.treeRadius
  let nearTree = false
  hash.forEachNear(px, pz, (tid) => {
    if (nearTree) return
    if (world.kind[tid] !== KIND_TREE) return
    const dx = world.positionX[tid] - px
    const dz = world.positionZ[tid] - pz
    if (dx * dx + dz * dz <= r2) nearTree = true
  })
  return (nearTree ? base * (1 + woodland.speedBonus) : base) * pace
}

export class MovementSystemImpl implements System {
  update(world: World, dt: number): void {
    const hash = world.spatialHash
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
      const speed = getEffectiveSpeed(world, id, hash)
      const step = Math.min(speed * dt, dist - world.stopDist[id])
      const nx = dx / dist
      const nz = dz / dist
      world.velocityX[id] = nx * speed
      world.velocityZ[id] = nz * speed
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

/** Patrol between current position and target. Engages enemies encountered. */
export function orderPatrol(world: World, id: number, x: number, z: number): void {
  // Store origin in resume fields
  world.resumeX[id] = world.positionX[id]
  world.resumeZ[id] = world.positionZ[id]
  world.targetX[id] = x
  world.targetZ[id] = z
  world.stopDist[id] = 0.5
  world.moving[id] = 1
  world.state[id] = STATE_PATROL
}

/** Hold position: attack enemies in range but don't move. */
export function orderHold(world: World, id: number): void {
  world.moving[id] = 0
  world.velocityX[id] = 0
  world.velocityZ[id] = 0
  world.state[id] = STATE_HOLD
}
