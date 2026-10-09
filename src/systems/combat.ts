import type { System, World } from '../core/World'
import {
  KIND_MELEE,
  KIND_RANGED,
  NO_TARGET,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  STATE_IDLE,
  STATE_MOVE,
} from '../core/World'

/**
 * Combat: melee and ranged units acquire the nearest visible enemy, chase it
 * into weapon reach (range + target footprint), and strike on cooldown.
 * Workers do not fight. Deaths are collected and removed after the sweep so
 * no system iterates a mutating entity set.
 */
export class CombatSystemImpl implements System {
  update(world: World, dt: number): void {
    const dead: number[] = []
    for (const id of world.entities.keys()) {
      const kind = world.kind[id]
      if (kind !== KIND_MELEE && kind !== KIND_RANGED) continue

      // Explicit move order finished: back to idle so the AI (and player)
      // can issue fresh orders. (Workers get this from the gather system.)
      if (world.state[id] === STATE_MOVE && world.moving[id] === 0) {
        world.state[id] = STATE_IDLE
      }

      if (world.cooldown[id] > 0) world.cooldown[id] -= dt

      let target = world.targetId[id]
      if (target === NO_TARGET || !world.entities.has(target) || world.health[target] <= 0) {
        // Auto-acquire: idle soldiers defend themselves, attack-move engages
        // on the march. Plain move orders (STATE_MOVE) walk through.
        const stance = world.state[id]
        if (stance === STATE_IDLE || stance === STATE_ATTACKMOVE || stance === STATE_ATTACK) {
          target = findNearestEnemy(world, id)
        } else {
          target = NO_TARGET
        }
        world.targetId[id] = target
      }
      if (target === NO_TARGET) {
        if (world.state[id] === STATE_ATTACK) {
          // Was attack-moving: resume the march. Otherwise go idle.
          if (!Number.isNaN(world.resumeX[id])) {
            world.targetX[id] = world.resumeX[id]
            world.targetZ[id] = world.resumeZ[id]
            world.stopDist[id] = 0.5
            world.moving[id] = 1
            world.state[id] = STATE_ATTACKMOVE
          } else {
            world.state[id] = STATE_IDLE
          }
        }
        // ATTACKMOVE with no target yet: movement system keeps walking.
        continue
      }

      const reach = world.attackRange[id] + world.radius[target]
      const dist = Math.hypot(
        world.positionX[target] - world.positionX[id],
        world.positionZ[target] - world.positionZ[id],
      )
      if (dist <= reach) {
        world.moving[id] = 0
        world.velocityX[id] = 0
        world.velocityZ[id] = 0
        world.state[id] = STATE_ATTACK
        if (world.cooldown[id] <= 0) {
          world.cooldown[id] = world.cooldownTotal[id]
          world.health[target] -= world.damage[id]
          if (world.health[target] <= 0 && !dead.includes(target)) dead.push(target)
        }
      } else {
        world.targetX[id] = world.positionX[target]
        world.targetZ[id] = world.positionZ[target]
        world.stopDist[id] = Math.max(0.1, reach * 0.9)
        world.moving[id] = 1
        world.state[id] = STATE_ATTACK
      }
    }
    for (const id of dead) world.removeEntityById(id)
  }
}

/** Nearest living enemy (unit or building) within sight, or NO_TARGET. */
function findNearestEnemy(world: World, id: number): number {
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const team = world.team[id]
  const sight = world.sight[id]
  let best = NO_TARGET
  let bestDist = sight
  for (const other of world.entities.keys()) {
    if (other === id) continue
    if (world.team[other] === team) continue
    if (!world.isAttackable(other)) continue
    if (world.health[other] <= 0) continue
    const d =
      Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz) -
      world.radius[other]
    if (d < bestDist) {
      bestDist = d
      best = other
    }
  }
  return best
}

/** Order a combat unit to attack a specific target. */
export function orderAttack(world: World, id: number, target: number): void {
  const kind = world.kind[id]
  if (kind !== KIND_MELEE && kind !== KIND_RANGED) return
  world.resumeX[id] = NaN
  world.resumeZ[id] = NaN
  world.targetId[id] = target
  world.state[id] = STATE_ATTACK
}

/** Order a combat unit to march to a point, engaging enemies on the way. */
export function orderAttackMove(world: World, id: number, x: number, z: number): void {
  const kind = world.kind[id]
  if (kind !== KIND_MELEE && kind !== KIND_RANGED) return
  world.targetX[id] = x
  world.targetZ[id] = z
  world.resumeX[id] = x
  world.resumeZ[id] = z
  world.stopDist[id] = 0.5
  world.moving[id] = 1
  world.state[id] = STATE_ATTACKMOVE
}
