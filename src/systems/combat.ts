import type { System, World } from '../core/World'
import { KIND_TOWER } from '../core/World'
import { chargeWarHorn, rallyDamageMult, rallySpeedMult } from './warhorn.ts'
import { SpatialHash } from '../core/spatial-hash.ts'
import { FACTIONS } from '../data/factions.ts'
import { WORLD_TICKS_PER_SECOND } from '../core/time.ts'
import {
  KIND_MELEE,
  KIND_RANGED,
  KIND_TREANT,
  KIND_WORKER,
  KIND_HALL,
  KIND_TREE,
  KIND_GOLDMINE,
  NO_TARGET,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  STATE_PATROL,
  STATE_HOLD,
  STATE_IDLE,
  STATE_MOVE,
} from '../core/World'

/**
 * Combat: melee and ranged units acquire the nearest visible enemy, chase it
 * into weapon reach (range + target footprint), and strike on cooldown.
 * Workers do not fight. Deaths are collected and removed after the sweep so
 * no system iterates a mutating entity set.
 */
/**
 * Counter system: unit type advantages.
 * - Melee crushes workers (1.5x) but resists ranged (takes 0.7x from ranged)
 * - Ranged kites melee effectively but is fragile up close
 * - Workers are weak fighters vs everything
 */
function getCounterMultiplier(world: World, attacker: number, target: number): number {
  let aKind = world.kind[attacker]
  const tKind = world.kind[target]
  // Militia Bell: levy pikemen fight as soldiers, not workers.
  if (aKind === KIND_WORKER && world.isMilitia(attacker)) aKind = 1 // KIND_MELEE
  // KIND_WORKER=0, KIND_MELEE=1, KIND_RANGED=2 (from World.ts)
  if (aKind === 1 && tKind === 0) return 1.5 // Melee vs Worker: slaughter
  if (aKind === 2 && tKind === 1) return 0.7 // Ranged vs Melee: resisted
  if (aKind === 1 && tKind === 2) return 1.25 // Melee vs Ranged: crush if close
  if (aKind === 0) return 0.6 // Worker vs anything: weak
  return 1.0
}

export class CombatSystemImpl implements System {
  update(world: World, dt: number): void {
    const hash = world.spatialHash
    const dead: number[] = []
    // Towers auto-attack nearest enemy in range
    this.updateTowers(world, dt, dead, hash)
    for (const id of world.entities.keys()) {
      const kind = world.kind[id]
      // Militia Bell: human peasants serving as Levy Pikemen fight alongside soldiers.
      const isMilitia = kind === KIND_WORKER && world.isMilitia(id)
      if (kind !== KIND_MELEE && kind !== KIND_RANGED && kind !== KIND_TREANT && !isMilitia) continue

      // Explicit move order finished: back to idle so the AI (and player)
      // can issue fresh orders. (Workers get this from the gather system.)
      if (world.state[id] === STATE_MOVE && world.moving[id] === 0) {
        world.state[id] = STATE_IDLE
      }
      // Attack-move reached its destination with nothing left to fight:
      // go idle so fresh orders can be issued.
      if (
        world.state[id] === STATE_ATTACKMOVE &&
        world.moving[id] === 0 &&
        world.targetId[id] === NO_TARGET
      ) {
        world.state[id] = STATE_IDLE
        world.resumeX[id] = NaN
        world.resumeZ[id] = NaN
      }
      // Patrol reached destination: swap origin/destination and continue.
      if (
        world.state[id] === STATE_PATROL &&
        world.moving[id] === 0 &&
        world.targetId[id] === NO_TARGET
      ) {
        const ox = world.resumeX[id]
        const oz = world.resumeZ[id]
        world.resumeX[id] = world.targetX[id]
        world.resumeZ[id] = world.targetZ[id]
        world.targetX[id] = ox
        world.targetZ[id] = oz
        world.moving[id] = 1
      }

      if (world.cooldown[id] > 0) world.cooldown[id] -= dt

      let target = world.targetId[id]
      // A pre-set target is honored only if it is still a legitimate one:
      // attackable and not our own team. Pre-set targets bypass the checks
      // in findNearestEnemy, so without this a mustered militia peasant —
      // whose targetId still points at the gold mine or tree it was
      // gathering — swings on its own resource field (nodes have 1 HP;
      // one 4x militia swing deletes a mine). Resource nodes are not
      // attackable and friendly units/buildings are not enemies; stale
      // targets of either kind fall through to normal acquisition.
      // (Post-ring defense audit 2026-10-23, Finding 1.)
      if (
        target === NO_TARGET ||
        !world.entities.has(target) ||
        world.health[target] <= 0 ||
        !world.isAttackable(target) ||
        world.team[target] === world.team[id]
      ) {
        // Auto-acquire: idle soldiers defend themselves, attack-move engages
        // on the march. Plain move orders (STATE_MOVE) walk through.
        const stance = world.state[id]
        if (stance === STATE_IDLE || stance === STATE_ATTACKMOVE || stance === STATE_ATTACK || stance === STATE_PATROL || stance === STATE_HOLD) {
          target = findNearestEnemy(world, id, hash)
          // Hold position: only engage if enemy is within weapon range + small buffer
          if (stance === STATE_HOLD && target !== NO_TARGET) {
            const d = Math.hypot(
              world.positionX[target] - world.positionX[id],
              world.positionZ[target] - world.positionZ[id],
            )
            const weaponRange = world.attackRange[id] + world.radius[target]
            if (d > weaponRange + 3) target = NO_TARGET
          }
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
          // Gale March: the rally quickens blades as well as boots.
          world.cooldown[id] = world.cooldownTotal[id] / rallySpeedMult(world, world.team[id] as 0 | 1)
          // Mark both combatants (for momentum tracking)
          world.lastCombatTick[id] = world.tick
          world.lastCombatTick[target] = world.tick
          // Apply Orc momentum bonus
          const momentumBonus = this.getMomentumBonus(world, id)
          // Militia Bell: human peasants fight as Levy Pikemen (4x damage).
          const militiaBonus =
            world.kind[id] === KIND_WORKER && world.isMilitia(id) ? 4 : 1
          // War Horn: Ironblood lends its edge.
          const rallyBonus = rallyDamageMult(world, world.team[id] as 0 | 1)
          const dmg = world.damage[id] * getCounterMultiplier(world, id, target) * momentumBonus * militiaBonus * rallyBonus
          world.health[target] -= dmg
          // War Horn: every blow struck charges the horn. Neutral
          // creatures (treants) belong to no team and charge nothing.
          if (world.team[id] <= 1) {
            chargeWarHorn(world, world.team[id] as 0 | 1, dmg)
          }
          // Orc Plunder: sacking enemy buildings yields gold (10% of damage dealt).
          const atkTeam = world.team[id] as 0 | 1
          if (world.factionOfTeam[atkTeam] === 'orc') {
            const tk = world.kind[target]
            const isBuilding = tk >= KIND_HALL && tk !== KIND_TREE && tk !== KIND_GOLDMINE
            if (isBuilding && world.team[target] !== atkTeam) {
              world.gold[atkTeam] += dmg * 0.1
            }
          }
          world.damageNumbers.push({
            x: world.positionX[target],
            z: world.positionZ[target],
            amount: Math.round(dmg),
            team: world.team[target],
            age: 0,
          })
          // Combat feel: white hit-flash on the struck entity.
          world.hitFlashes.push({ id: target })
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
    for (const id of dead) {
      this.tryReanimate(world, id)
      // Combat feel: expanding death-pop at the kill position (visual-only).
      world.deathPops.push({
        x: world.positionX[id],
        z: world.positionZ[id],
        r: world.radius[id],
        team: world.team[id],
        kind: world.kind[id],
        age: 0,
      })
      // Soul-Ash (undead racial): every fallen unit feeds the Undead supply
      // cap — each corpse renders one soul-ash, and each soul-ash is one
      // point of capacity. A rival buys a farm's +6 cap for 130 resources,
      // on demand; undead pays six deaths for the same +6, and only through
      // combat it must survive — corpses at 1:1 is still the steepest
      // supply price any faction pays. (At the old 3:1 the cap could never
      // grow before undead had an army, and it could not field an army
      // without cap: the supply trap, audit 2026-10-22.)
      if (world.kind[id] <= KIND_RANGED) {
        for (const t of [0, 1] as const) {
          if (world.factionOfTeam[t] === 'undead') {
            world.soulAsh[t] += 1
            world.supplyCap[t] += 1
          }
        }
      }
      world.removeEntityById(id)
    }
    // Creeping Blight (undead racial): the dead knit themselves back together.
    // Undead units regenerate 2% max HP/sec after 5 seconds out of combat.
    // The delay is a world.tick gap, and world.tick advances at
    // WORLD_TICKS_PER_SECOND (60/s) under every driver — denominating it in
    // TICK_RATE (20, the data-table storage convention) made the delay
    // 100 ticks = 1.67 s in practice (audit 2026-10-22).
    for (const id of world.entities.keys()) {
      const kind = world.kind[id]
      if (kind !== KIND_MELEE && kind !== KIND_RANGED && kind !== KIND_WORKER) continue
      if (world.factionOfTeam[world.team[id] as 0 | 1] !== 'undead') continue
      if (world.tick - world.lastCombatTick[id] < 5 * WORLD_TICKS_PER_SECOND) continue
      if (world.health[id] >= world.maxHealth[id]) continue
      world.health[id] = Math.min(world.maxHealth[id], world.health[id] + world.maxHealth[id] * 0.02 * dt)
    }
  }

  /**
   * Orc signature: damage bonus scaling with consecutive combat ticks.
   * Deterministic: purely tick-based, no RNG.
   */
  private getMomentumBonus(world: World, id: number): number {
    // Neutral creatures (treants) belong to no faction: no momentum.
    if (world.team[id] > 1) return 1
    const team = world.team[id] as 0 | 1
    const momentum = FACTIONS[world.factionOfTeam[team]].signature?.momentum
    if (!momentum) return 1
    const bonus = (world.momentumTicks[id] * momentum.damagePerSec) / 60 // TICK_RATE
    return 1 + Math.min(bonus, momentum.maxBonus)
  }

  /**
   * Undead signature: fallen units may reanimate as temporary skeletons.
   * Deterministic: roll uses hash(entityId, tick) so PvP stays in sync.
   */
  private tryReanimate(world: World, deadId: number): void {
    // Neutral creatures (treants) belong to no faction: nothing reanimates them.
    if (world.team[deadId] > 1) return
    const team = world.team[deadId] as 0 | 1
    const faction = FACTIONS[world.factionOfTeam[team]]
    const reanimate = faction.signature?.reanimate
    if (!reanimate) return

    // Skip if this was already a reanimated unit (no chain reanimation)
    if (world.reanimateTicks[deadId] !== 0) return

    // Deterministic roll: hash of entity id and tick
    const hash = ((deadId * 2654435761) ^ (world.tick * 40503)) >>> 0
    const roll = (hash % 10000) / 10000
    if (roll >= reanimate.chance) return

    // Spawn a skeleton (melee) at the death position
    const x = world.positionX[deadId]
    const z = world.positionZ[deadId]
    const entity = world.spawnUnit('melee', team, x, z)
    const newId = entity.id

    // Apply reanimation: reduced HP, limited lifetime. reanimateTicks is a
    // per-update countdown in World.update, and updates run at
    // WORLD_TICKS_PER_SECOND (60/s) — denominating the designed seconds in
    // TICK_RATE (20) made skeletons live 5 s instead of 15 (audit 2026-10-22).
    const maxHp = world.maxHealth[newId]
    const reHp = Math.max(1, Math.round(maxHp * reanimate.hpFactor))
    world.health[newId] = reHp
    world.maxHealth[newId] = reHp
    world.reanimateTicks[newId] = Math.round(reanimate.durationSec * WORLD_TICKS_PER_SECOND)
  }

  /**
   * Towers automatically attack the nearest enemy in range.
   * Deterministic: iterates in entity order, same as findNearestEnemy.
   */
  private updateTowers(world: World, dt: number, dead: number[], hash: SpatialHash): void {
    for (const id of world.entities.keys()) {
      if (world.kind[id] !== KIND_TOWER) continue
      if (world.health[id] <= 0) continue
      // Only completed towers attack (under construction = vulnerable)
      if (world.buildProgress[id] < world.buildTotal[id]) continue

      if (world.cooldown[id] > 0) {
        world.cooldown[id] -= dt
        continue
      }

      const target = findNearestEnemy(world, id, hash)
      if (target === NO_TARGET) continue

      // Check range (towers use attackRange)
      const d = Math.hypot(
        world.positionX[target] - world.positionX[id],
        world.positionZ[target] - world.positionZ[id],
      ) - world.radius[target]
      if (d > world.attackRange[id]) continue

      // Fire!
      world.cooldown[id] = world.cooldownTotal[id]
      const dmg = world.damage[id]
      world.health[target] -= dmg
      // War Horn: tower kills charge the horn too.
      chargeWarHorn(world, world.team[id] as 0 | 1, dmg)
      world.damageNumbers.push({
        x: world.positionX[target],
        z: world.positionZ[target],
        amount: Math.round(dmg),
        team: world.team[target],
        age: 0,
      })
      // Combat feel: white hit-flash on the struck entity.
      world.hitFlashes.push({ id: target })
      // Mark combatants for momentum tracking
      world.lastCombatTick[id] = world.tick
      world.lastCombatTick[target] = world.tick
      if (world.health[target] <= 0 && !dead.includes(target)) dead.push(target)
    }
  }
}

/** Nearest living enemy (unit or building) within sight, or NO_TARGET.
 * Uses the spatial hash; tie-broken by world order to match linear scan. */
function findNearestEnemy(world: World, id: number, hash: SpatialHash): number {
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const team = world.team[id]
  const sight = world.sight[id]
  let best = NO_TARGET
  let bestDist = sight
  let bestSeq = Number.MAX_SAFE_INTEGER
  hash.forEachNear(px, pz, (other) => {
    if (other === id) return
    if (world.team[other] === team) return
    if (!world.isAttackable(other)) return
    if (world.health[other] <= 0) return
    const d =
      Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz) -
      world.radius[other]
    const seq = hash.sequenceOf(other)
    if (d < bestDist || (d === bestDist && seq < bestSeq)) {
      bestDist = d
      bestSeq = seq
      best = other
    }
  })
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
