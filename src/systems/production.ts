import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { FACTIONS } from '../data/factions.ts'
import { getUnits } from '../data/stats.ts'
import { UPGRADES, type UpgradeType } from '../data/upgrades.ts'
import type { UnitType } from '../data/units.ts'
import { TICK_RATE } from '../core/time.ts'
import type { System, World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_WORKER,
  NO_TRAINING,
  STATE_MOVE,
} from '../core/World'

/** Building type per kind index (0-2 are units, unused here). */
const BUILDING_TYPE_BY_KIND: BuildingType[] = [
  'hall',
  'hall',
  'hall',
  'hall',
  'barracks',
  'archery',
  'farm',
]

const KIND_BY_UNIT: Record<UnitType, number> = {
  worker: KIND_WORKER,
  melee: KIND_MELEE,
  ranged: KIND_RANGED,
}

/**
 * Production: each finished building trains one unit at a time. When the
 * timer completes the unit spawns at the building's edge and walks to the
 * rally point. Costs are charged when the item is queued (enqueueTrain).
 * Also ticks Orc in-place building upgrades (upgradeLeft).
 */
export class ProductionSystemImpl implements System {
  update(world: World, dt: number): void {
    for (const id of world.entities.keys()) {
      // Orc in-place upgrading: the building reforges itself, tier by tier.
      if (world.upgradeLeft[id] > 0) {
        world.upgradeLeft[id] -= dt
        if (world.upgradeLeft[id] <= 0) {
          world.upgradeLeft[id] = 0
          completeUpgrade(world, id)
        }
        continue // A building mid-upgrade neither trains nor starts another.
      }
      if (world.trainKind[id] === NO_TRAINING) continue
      if (world.buildProgress[id] < world.buildTotal[id]) continue // still under construction
      world.trainLeft[id] -= dt
      if (world.trainLeft[id] > 0) continue

      const kind = world.trainKind[id]
      world.trainKind[id] = NO_TRAINING
      const team = world.team[id] as 0 | 1
      const type: UnitType =
        kind === KIND_WORKER ? 'worker' : kind === KIND_MELEE ? 'melee' : 'ranged'
      const unit = world.spawnUnit(
        type,
        team,
        world.positionX[id] + world.radius[id] + 1.5,
        world.positionZ[id],
      )
      const uid = unit.id
      // Orc Foundry: higher tiers forge tougher soldiers.
      const bTier = world.tier[id]
      if (world.factionOfTeam[team] === 'orc' && bTier > 1 && kind !== KIND_WORKER) {
        const hpMult = 1 + 0.15 * (bTier - 1)
        const dmgMult = 1 + 0.1 * (bTier - 1)
        world.health[uid] *= hpMult
        world.maxHealth[uid] *= hpMult
        world.damage[uid] *= dmgMult
      }
      world.targetX[uid] = world.rallyX[id]
      world.targetZ[uid] = world.rallyZ[id]
      world.stopDist[uid] = 0.5
      world.moving[uid] = 1
      world.state[uid] = STATE_MOVE
      // Game-feel: completion cue (visual-only; renderer drains it each frame).
      world.completionFlashes.push({ id, unit: true, team })
    }
  }
}

/** Orc tier names for the in-place upgrade path. */
export const ORC_TIER_NAMES = ["Iron-Bound", "Blood-Forged", "Warlord's Anvil"] as const

/** Upgrade costs and build time per step (index = current tier). */
const TIER_UPGRADES = [
  { gold: 0, wood: 0, time: 0 }, // tier 1: base
  { gold: 150, wood: 100, time: 20 }, // 1 -> 2
  { gold: 300, wood: 200, time: 30 }, // 2 -> 3
]

/**
 * Orc in-place upgrading (v2.0 spec): War-Halls and Foundries reforge
 * themselves through three tiers without rebuilding. Returns true when the
 * upgrade starts. The building cannot train while upgrading.
 */
export function upgradeBuilding(world: World, buildingId: number): boolean {
  if (!world.entities.has(buildingId)) return false
  const team = world.team[buildingId] as 0 | 1
  if (world.factionOfTeam[team] !== 'orc') return false
  const kind = world.kind[buildingId]
  if (kind !== KIND_HALL && kind !== KIND_BARRACKS) return false
  if (world.buildProgress[buildingId] < world.buildTotal[buildingId]) return false // unfinished
  if (world.upgradeLeft[buildingId] > 0) return false // already upgrading
  const tier = world.tier[buildingId]
  if (tier >= 3) return false
  const cost = TIER_UPGRADES[tier]
  if (world.gold[team] < cost.gold || world.wood[team] < cost.wood) return false
  world.gold[team] -= cost.gold
  world.wood[team] -= cost.wood
  world.upgradeLeft[buildingId] = cost.time
  return true
}

/** Finish a tier upgrade: bump the tier and reinforce the structure. */
function completeUpgrade(world: World, id: number): void {
  world.tier[id] = Math.min(3, world.tier[id] + 1) as 1 | 2 | 3
  // Each tier adds 40% max HP; heal the building by the same proportion.
  const newMax = world.maxHealth[id] * 1.4
  const ratio = world.health[id] / world.maxHealth[id]
  world.maxHealth[id] = newMax
  world.health[id] = newMax * ratio
}

/**
 * Queue a unit at a finished building. Returns false when the building can't
 * train the type, is busy, is unfinished, or the team can't afford it.
 * Faction cost/train-time modifiers apply.
 */
export function enqueueTrain(world: World, buildingId: number, type: UnitType): boolean {
  const kind = world.kind[buildingId]
  if (kind !== KIND_HALL && kind !== KIND_BARRACKS && kind !== KIND_ARCHERY && kind !== KIND_FARM) {
    return false
  }
  const def = BUILDINGS[BUILDING_TYPE_BY_KIND[kind]]
  if (!def.trains.includes(type)) return false
  if (world.buildProgress[buildingId] < world.buildTotal[buildingId]) return false
  if (world.trainKind[buildingId] !== NO_TRAINING) return false
  if (world.upgradeLeft[buildingId] > 0) return false // mid-upgrade: no training

  const team = world.team[buildingId]
  const mods = FACTIONS[world.factionOfTeam[team]].mods
  const unitDef = getUnits()[type]
  const goldCost = Math.round(unitDef.cost.gold * mods.cost)
  const woodCost = Math.round(unitDef.cost.wood * mods.cost)
  if (world.gold[team] < goldCost || world.wood[team] < woodCost) return false
  if (world.supplyUsed[team] + unitDef.popCost > world.supplyCap[team]) return false

  world.gold[team] -= goldCost
  world.wood[team] -= woodCost
  world.trainKind[buildingId] = KIND_BY_UNIT[type]
  // Orc War-Hall: higher tiers muster troops faster.
  const tierBonus = world.factionOfTeam[team] === 'orc' ? Math.pow(0.85, world.tier[buildingId] - 1) : 1
  world.trainTotal[buildingId] = (unitDef.trainTicks / TICK_RATE) * mods.train * tierBonus
  world.trainLeft[buildingId] = world.trainTotal[buildingId]
  return true
}

/** Set where newly trained units from this building will gather. */
export function setRally(world: World, buildingId: number, x: number, z: number): void {
  const kind = world.kind[buildingId]
  if (kind !== KIND_HALL && kind !== KIND_BARRACKS && kind !== KIND_ARCHERY) return
  world.rallyX[buildingId] = x
  world.rallyZ[buildingId] = z
}

/**
 * The price of a ladder's next level for a team, faction factor applied
 * (human's Adaptable signature: 0.8x, so 80g/40w against the base
 * 100g/50w). Single source of truth: researchUpgrade charges exactly
 * this, and the AI's research gate floors on it.
 */
export function researchCost(
  world: World,
  team: 0 | 1,
  type: UpgradeType,
): { gold: number; wood: number } {
  const def = UPGRADES[type]
  // Human signature: adaptable upgrades cost less
  const costFactor = FACTIONS[world.factionOfTeam[team]].signature?.adaptable?.upgradeCostFactor ?? 1
  return {
    gold: Math.ceil(def.cost.gold * costFactor),
    wood: Math.ceil(def.cost.wood * costFactor),
  }
}

/** Research an upgrade at a building. Returns true if successful. */
export function researchUpgrade(world: World, buildingId: number, type: UpgradeType): boolean {
  const team = world.team[buildingId] as 0 | 1
  const def = UPGRADES[type]
  const currentLvl = type === 'meleeDmg' ? world.meleeDmgLvl[team]
    : type === 'meleeHp' ? world.meleeHpLvl[team]
    : world.rangedDmgLvl[team]
  if (currentLvl >= def.maxLevel) return false
  const cost = researchCost(world, team, type)
  if (world.gold[team] < cost.gold || world.wood[team] < cost.wood) return false
  world.gold[team] -= cost.gold
  world.wood[team] -= cost.wood
  if (type === 'meleeDmg') world.meleeDmgLvl[team]++
  else if (type === 'meleeHp') world.meleeHpLvl[team]++
  else world.rangedDmgLvl[team]++
  return true
}
