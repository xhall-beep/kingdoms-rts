import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { FACTIONS } from '../data/factions.ts'
import { UNITS } from '../data/units.ts'
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
 */
export class ProductionSystemImpl implements System {
  update(world: World, dt: number): void {
    for (const id of world.entities.keys()) {
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
      world.targetX[uid] = world.rallyX[id]
      world.targetZ[uid] = world.rallyZ[id]
      world.stopDist[uid] = 0.5
      world.moving[uid] = 1
      world.state[uid] = STATE_MOVE
    }
  }
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

  const team = world.team[buildingId]
  const mods = FACTIONS[world.factionOfTeam[team]].mods
  const unitDef = UNITS[type]
  const goldCost = Math.round(unitDef.cost.gold * mods.cost)
  const woodCost = Math.round(unitDef.cost.wood * mods.cost)
  if (world.gold[team] < goldCost || world.wood[team] < woodCost) return false
  if (world.supplyUsed[team] + unitDef.popCost > world.supplyCap[team]) return false

  world.gold[team] -= goldCost
  world.wood[team] -= woodCost
  world.trainKind[buildingId] = KIND_BY_UNIT[type]
  world.trainTotal[buildingId] = (unitDef.trainTicks / TICK_RATE) * mods.train
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

/** Research an upgrade at a building. Returns true if successful. */
export function researchUpgrade(world: World, buildingId: number, type: UpgradeType): boolean {
  const team = world.team[buildingId] as 0 | 1
  const def = UPGRADES[type]
  const currentLvl = type === 'meleeDmg' ? world.meleeDmgLvl[team]
    : type === 'meleeHp' ? world.meleeHpLvl[team]
    : world.rangedDmgLvl[team]
  if (currentLvl >= def.maxLevel) return false
  if (world.gold[team] < def.cost.gold || world.wood[team] < def.cost.wood) return false
  world.gold[team] -= def.cost.gold
  world.wood[team] -= def.cost.wood
  if (type === 'meleeDmg') world.meleeDmgLvl[team]++
  else if (type === 'meleeHp') world.meleeHpLvl[team]++
  else world.rangedDmgLvl[team]++
  return true
}
