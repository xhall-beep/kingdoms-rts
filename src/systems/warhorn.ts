import type { System, World } from '../core/World.ts'
import { KIND_MELEE, KIND_RANGED, KIND_WORKER } from '../core/World.ts'

/**
 * The War Horn (v2.0 spec, section 3).
 *
 * Momentum made audible: dealing damage charges the horn (0-100). Sounding it
 * costs 50 charge and rallies the army for 20 seconds:
 *   Gale March — +30% move and attack speed
 *   Ironblood  — +25% damage
 *   Second Wind — restore 30% max HP instantly
 * Coward's Decay: 45 seconds without dealing damage empties the horn.
 * Turtling earns no glory.
 */

/** Rally kinds. */
export const RALLY_NONE = 0
export const RALLY_GALE = 1
export const RALLY_IRONBLOOD = 2
export const RALLY_NAMES = ['', 'Gale March', 'Ironblood'] as const

const HORN_COST = 50
const RALLY_DURATION = 20
const DECAY_PEACE_TICKS = 45 * 60 // 45 seconds of peace empties the horn

/** Charge the horn when a team deals damage. Call from every damage path. */
export function chargeWarHorn(world: World, team: 0 | 1, damage: number): void {
  world.warCharge[team] = Math.min(100, world.warCharge[team] + damage * 0.05)
  world.warLastTick[team] = world.tick
}

/**
 * Sound the war horn. rally: 1 = Gale March, 2 = Ironblood, 3 = Second Wind.
 * Returns true when the rally starts. Costs 50 charge.
 */
export function soundWarHorn(world: World, team: 0 | 1, rally: 1 | 2 | 3): boolean {
  if (world.warCharge[team] < HORN_COST) return false
  if (world.rallyKind[team] !== RALLY_NONE && world.rallyUntil[team] > world.matchTime) {
    return false // already rallying
  }
  world.warCharge[team] -= HORN_COST
  if (rally === 3) {
    // Second Wind: the army breathes again — restore 30% max HP now.
    for (const id of world.entities.keys()) {
      if (world.team[id] !== team) continue
      const k = world.kind[id]
      if (k !== KIND_MELEE && k !== KIND_RANGED && k !== KIND_WORKER) continue
      world.health[id] = Math.min(world.maxHealth[id], world.health[id] + world.maxHealth[id] * 0.3)
    }
    return true
  }
  world.rallyKind[team] = rally
  world.rallyUntil[team] = world.matchTime + RALLY_DURATION
  return true
}

/** Damage multiplier for a team's active rally (Ironblood). */
export function rallyDamageMult(world: World, team: 0 | 1): number {
  if (world.rallyKind[team] === RALLY_IRONBLOOD && world.rallyUntil[team] > world.matchTime) {
    return 1.25
  }
  return 1
}

/** Move/attack-speed multiplier for a team's active rally (Gale March). */
export function rallySpeedMult(world: World, team: 0 | 1): number {
  if (world.rallyKind[team] === RALLY_GALE && world.rallyUntil[team] > world.matchTime) {
    return 1.3
  }
  return 1
}

export class WarHornSystemImpl implements System {
  update(world: World): void {
    for (const t of [0, 1] as const) {
      // Coward's Decay: peace empties the horn.
      if (world.warCharge[t] > 0 && world.tick - world.warLastTick[t] > DECAY_PEACE_TICKS) {
        world.warCharge[t] = 0
      }
      // Rallies expire.
      if (world.rallyKind[t] !== RALLY_NONE && world.rallyUntil[t] <= world.matchTime) {
        world.rallyKind[t] = RALLY_NONE
      }
    }
  }
}
