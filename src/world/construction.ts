import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { World } from '../core/World'
import { KIND_ARCHERY, KIND_BARRACKS, KIND_FARM, KIND_HALL, NO_TARGET } from '../core/World'

/** BuildingType for each building kind constant. */
export const BUILDING_TYPE_BY_KIND: Record<number, BuildingType> = {
  [KIND_HALL]: 'hall',
  [KIND_BARRACKS]: 'barracks',
  [KIND_ARCHERY]: 'archery',
  [KIND_FARM]: 'farm',
}

/** Buildings the player is allowed to place. Halls are scenario/AI only. */
export const PLAYER_BUILDABLE: BuildingType[] = ['farm', 'barracks', 'archery']

/**
 * Shared construction rules used by both the AI and player input.
 * Deducts costs, validates the footprint, and spawns the unfinished structure.
 * The caller is responsible for sending a worker via orderBuild.
 */
export function placeStructure(
  world: World,
  team: 0 | 1,
  type: BuildingType,
  x: number,
  z: number,
): { ok: boolean; id: number } {
  const def = BUILDINGS[type]
  if (world.gold[team] < def.cost.gold || world.wood[team] < def.cost.wood) {
    return { ok: false, id: NO_TARGET }
  }
  if (!isAreaFree(world, x, z, def.radius)) return { ok: false, id: NO_TARGET }
  world.gold[team] -= def.cost.gold
  world.wood[team] -= def.cost.wood
  const entity = world.spawnBuilding(type, team, x, z, false)
  return { ok: true, id: entity.id }
}

/** True when no other entity's footprint overlaps the proposed building. */
export function isAreaFree(world: World, x: number, z: number, radius: number): boolean {
  for (const id of world.entities.keys()) {
    if (world.radius[id] <= 0) continue
    const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z)
    if (d < world.radius[id] + radius + 1) return false
  }
  return true
}

/** Can this team currently afford this building type? */
export function canAfford(world: World, team: 0 | 1, type: BuildingType): boolean {
  const def = BUILDINGS[type]
  return world.gold[team] >= def.cost.gold && world.wood[team] >= def.cost.wood
}
