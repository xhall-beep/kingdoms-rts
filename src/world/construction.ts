import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { World } from '../core/World'
import { KIND_ARCHERY, KIND_BARRACKS, KIND_FARM, KIND_HALL, KIND_MELEE, KIND_RANGED, KIND_SMITHY, KIND_TOWER, KIND_TREANT, KIND_WORKER, KIND_WORKSHOP, NO_TARGET } from '../core/World'

/** BuildingType for each building kind constant. */
export const BUILDING_TYPE_BY_KIND: Record<number, BuildingType> = {
  [KIND_HALL]: 'hall',
  [KIND_BARRACKS]: 'barracks',
  [KIND_ARCHERY]: 'archery',
  [KIND_FARM]: 'farm',
  [KIND_TOWER]: 'tower',
  [KIND_WORKSHOP]: 'workshop',
  [KIND_SMITHY]: 'smithy',
}

/** Buildings the player is allowed to place. Halls are scenario/AI only. */
export const PLAYER_BUILDABLE: BuildingType[] = ['farm', 'barracks', 'workshop', 'smithy', 'archery', 'tower']

/**
 * Tech-tree prerequisites (Montz directive 2026-10-26): the Workshop is
 * the tech root. The Smithy and the Archery Range cannot be placed until
 * the team has a FINISHED workshop standing — an under-construction
 * workshop unlocks nothing, and losing the workshop afterwards does not
 * un-place what already stands (it only blocks new placements).
 */
export const BUILDING_REQUIRES: Partial<Record<BuildingType, BuildingType>> = {
  smithy: 'workshop',
  archery: 'workshop',
}

/** True when `team` has at least one FINISHED building of `type` standing. */
export function teamHasFinishedBuilding(world: World, team: 0 | 1, type: BuildingType): boolean {
  for (const id of world.entities.keys()) {
    if (world.team[id] !== team) continue
    if (BUILDING_TYPE_BY_KIND[world.kind[id]] !== type) continue
    if (world.buildProgress[id] < world.buildTotal[id]) continue
    return true
  }
  return false
}

/** True when `type`'s tech prerequisite (if any) is met for `team`. */
export function buildingPrereqMet(world: World, team: 0 | 1, type: BuildingType): boolean {
  const req = BUILDING_REQUIRES[type]
  return req === undefined || teamHasFinishedBuilding(world, team, req)
}

/**
 * Shared construction rules used by both the AI and player input.
 * Deducts costs, validates the footprint, and spawns the unfinished structure.
 * The caller is responsible for sending a worker via orderBuild.
 */
/**
 * Pure placement check — the exact validation placeStructure applies,
 * without deducting or spawning. Used by the input layer to tint the
 * placement ghost honestly (green = will place, red = will not).
 */
export function canPlaceStructure(
  world: World,
  team: 0 | 1,
  type: BuildingType,
  x: number,
  z: number,
): boolean {
  const def = BUILDINGS[type]
  // Undead raise no farms: Soul-Ash from the fallen feeds their supply cap.
  if (type === 'farm' && world.factionOfTeam[team] === 'undead') return false
  // Tech tree: Smithy / Archery Range need a finished Workshop first.
  if (!buildingPrereqMet(world, team, type)) return false
  if (world.gold[team] < def.cost.gold || world.wood[team] < def.cost.wood) return false
  return isAreaFree(world, x, z, def.radius)
}

export function placeStructure(
  world: World,
  team: 0 | 1,
  type: BuildingType,
  x: number,
  z: number,
): { ok: boolean; id: number } {
  const def = BUILDINGS[type]
  if (!canPlaceStructure(world, team, type, x, z)) return { ok: false, id: NO_TARGET }
  world.gold[team] -= def.cost.gold
  world.wood[team] -= def.cost.wood
  const entity = world.spawnBuilding(type, team, x, z, false)
  return { ok: true, id: entity.id }
}

/** True when no other entity's footprint overlaps the proposed building. */
export function isAreaFree(world: World, x: number, z: number, radius: number): boolean {
  return placementBlocker(world, x, z, radius) === NO_TARGET
}

/**
 * The first entity whose footprint overlaps the proposed building, or
 * NO_TARGET when the area is free — isAreaFree's exact predicate,
 * returning the blocker instead of a boolean so the UI can say WHAT
 * is in the way (basics audit F10: one red ghost for every reason).
 */
export function placementBlocker(world: World, x: number, z: number, radius: number): number {
  for (const id of world.entities.keys()) {
    if (world.radius[id] <= 0) continue
    const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z)
    if (d < world.radius[id] + radius + 1) return id
  }
  return NO_TARGET
}

/**
 * Why a placement would refuse — canPlaceStructure's checks decomposed
 * in its own order, read-only. Returns null exactly when
 * canPlaceStructure returns true (the suite pins the equivalence over
 * staged states and a position sweep). The ghost and the refusal
 * banner phrase this; no acceptance outcome lives here.
 */
export type PlacementRefusal =
  | { kind: 'faction-rule' }
  | { kind: 'prereq' }
  | { kind: 'gold'; short: number }
  | { kind: 'wood'; short: number }
  | { kind: 'blocked-unit'; own: boolean }
  | { kind: 'blocked' }

const UNIT_KINDS: ReadonlySet<number> = new Set([KIND_WORKER, KIND_MELEE, KIND_RANGED, KIND_TREANT])

export function placementRefusal(
  world: World,
  team: 0 | 1,
  type: BuildingType,
  x: number,
  z: number,
): PlacementRefusal | null {
  const def = BUILDINGS[type]
  if (type === 'farm' && world.factionOfTeam[team] === 'undead') return { kind: 'faction-rule' }
  if (!buildingPrereqMet(world, team, type)) return { kind: 'prereq' }
  if (world.gold[team] < def.cost.gold) {
    return { kind: 'gold', short: Math.ceil(def.cost.gold - world.gold[team]) }
  }
  if (world.wood[team] < def.cost.wood) {
    return { kind: 'wood', short: Math.ceil(def.cost.wood - world.wood[team]) }
  }
  // Classify the blockage by the most actionable blocker: a unit can
  // be ordered away, a building or a tree cannot — so any overlapping
  // unit outranks the static blockers (a spot beside the hall can be
  // inside both the hall's and a standing worker's overlap, and the
  // worker is the reason the player can act on). An own unit outranks
  // a foreign one for the same reason.
  let sawStatic = false
  let sawForeignUnit = false
  for (const id of world.entities.keys()) {
    if (world.radius[id] <= 0) continue
    const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z)
    if (d >= world.radius[id] + def.radius + 1) continue
    if (UNIT_KINDS.has(world.kind[id])) {
      if (world.team[id] === team) return { kind: 'blocked-unit', own: true }
      sawForeignUnit = true
    } else {
      sawStatic = true
    }
  }
  if (sawForeignUnit) return { kind: 'blocked-unit', own: false }
  if (sawStatic) return { kind: 'blocked' }
  return null
}

/** Can this team currently afford this building type? */
export function canAfford(world: World, team: 0 | 1, type: BuildingType): boolean {
  const def = BUILDINGS[type]
  return world.gold[team] >= def.cost.gold && world.wood[team] >= def.cost.wood
}
