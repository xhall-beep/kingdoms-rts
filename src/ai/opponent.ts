import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { System, World } from '../core/World'
import {
  HARVEST_GOLD,
  HARVEST_WOOD,
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_WORKER,
  NO_TARGET,
  NO_TRAINING,
  STATE_IDLE,
} from '../core/World'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderMove } from '../systems/movement.ts'
import { enqueueTrain } from '../systems/production.ts'
import { canSee, isExplored } from '../world/visibility.ts'

const THINK_EVERY = 1.0 // seconds between decisions
const WORKER_TARGET = 10
const WORKERS_BEFORE_ARMY = 5 // Economy first: no military buildings before this many workers.
const ATTACK_ARMY = 8 // Soldiers needed before attacking.
const DEFENSE_RADIUS = 28 // Enemies this close to the hall pull the army home.
const WOOD_SHARE = 0.4 // Fraction of workers assigned to wood (the rest mine gold).

const BUILDING_TYPE_BY_KIND: Record<number, BuildingType> = {
  [KIND_HALL]: 'hall',
  [KIND_BARRACKS]: 'barracks',
  [KIND_ARCHERY]: 'archery',
  [KIND_FARM]: 'farm',
}

/**
 * Built-in opponent. It plays by the rules: every action goes through the same
 * commands as player input, so it can never cheat past costs or build times.
 * Deterministic: no randomness anywhere.
 *
 * Fog of war: it defends against enemy units it can currently SEE near its hall,
 * and only attacks the enemy hall once it has explored that spot. Until then it
 * marches toward the mirror of its own hall, then searches the map.
 */
export class OpponentAI implements System {
  private readonly team: 0 | 1
  private timer = 0

  constructor(team: 0 | 1) {
    this.team = team
  }

  update(world: World, dt: number): void {
    this.timer += dt
    if (this.timer < THINK_EVERY) return
    this.timer = 0

    const team = this.team
    const hall = structuresOf(world, team, KIND_HALL, true)[0]
    if (hall === undefined) return // Defeated.

    const workers = unitsOf(world, team, KIND_WORKER)
    const soldiers = [...unitsOf(world, team, KIND_MELEE), ...unitsOf(world, team, KIND_RANGED)]

    this.trainWorkers(world, hall, workers.length)
    this.assignWorkers(world, workers)
    const saving = this.expand(world, hall, workers)
    if (!saving) this.trainSoldiers(world, workers.length) // Don't buy soldiers while saving for a building.
    if (!this.defend(world, hall, soldiers)) this.attack(world, hall, soldiers)
  }

  private trainWorkers(world: World, hall: number, workerCount: number): void {
    const queued = world.trainKind[hall] !== NO_TRAINING ? 1 : 0 // Single training slot.
    if (workerCount + queued < WORKER_TARGET) enqueueTrain(world, hall, 'worker')
  }

  /** Idle workers go back to harvesting, keeping roughly WOOD_SHARE on wood. */
  private assignWorkers(world: World, workers: number[]): void {
    let onWood = 0
    for (const id of workers) {
      if (world.state[id] === STATE_IDLE) continue
      if (world.harvestKind[id] === HARVEST_WOOD) onWood += 1
    }
    const woodWanted = Math.ceil(workers.length * WOOD_SHARE)
    for (const id of workers) {
      if (world.state[id] !== STATE_IDLE) continue
      if (onWood < woodWanted) {
        world.harvestKind[id] = HARVEST_WOOD
        onWood += 1
      } else {
        world.harvestKind[id] = HARVEST_GOLD
      }
      orderGather(world, id)
    }
  }

  /**
   * At most one new structure per decision, in priority order.
   * Returns true while saving up for one (pauses soldier training).
   */
  private expand(world: World, hall: number, workers: number[]): boolean {
    const team = this.team
    const all = (kind: number): number => structuresOf(world, team, kind, false).length
    const pending = (kind: number): number => all(kind) - structuresOf(world, team, kind, true).length
    const slack = world.supplyCap[team] - world.supplyUsed[team]
    const ready = workers.length >= WORKERS_BEFORE_ARMY

    // Priority order. Farms only jump the queue when population is truly blocked,
    // otherwise cheap farms would starve the military buildings forever.
    let want: number | null = null
    if (ready && all(KIND_BARRACKS) === 0) want = KIND_BARRACKS
    else if (slack <= 1 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && all(KIND_ARCHERY) === 0) want = KIND_ARCHERY
    else if (slack <= 3 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && world.gold[team] >= 400 && all(KIND_BARRACKS) < 2 && pending(KIND_BARRACKS) === 0) {
      want = KIND_BARRACKS
    }
    if (want === null) return false
    return this.build(world, hall, want, workers)
  }

  /** Place a structure in a free spot around the hall and send a worker to build it. */
  private build(world: World, hall: number, kind: number, workers: number[]): boolean {
    const type = BUILDING_TYPE_BY_KIND[kind]
    const def = BUILDINGS[type]
    if (world.gold[this.team] < def.cost.gold || world.wood[this.team] < def.cost.wood) {
      return true // Saving up; try again once affordable.
    }
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const ringBase = BUILDINGS.hall.radius + def.radius + 3
    for (let k = 0; k < 30; k += 1) {
      const ring = Math.floor(k / 10)
      const angle = (k % 10) * 0.628 + ring * 0.3
      const r = ringBase + ring * 4
      const placed = placeStructure(
        world,
        this.team,
        type,
        hx + Math.cos(angle) * r,
        hz + Math.sin(angle) * r,
      )
      if (placed.ok) {
        const builder =
          workers.find((id) => world.state[id] === STATE_IDLE) ??
          workers.find((id) => world.carryAmount[id] === 0)
        if (builder !== undefined) orderBuild(world, builder, placed.id)
        return false
      }
    }
    return false // No free spot; try again next decision.
  }

  private trainSoldiers(world: World, workerCount: number): void {
    if (workerCount < WORKERS_BEFORE_ARMY) return
    const jobs: [number, 'melee' | 'ranged'][] = [
      [KIND_BARRACKS, 'melee'],
      [KIND_ARCHERY, 'ranged'],
    ]
    for (const [kind, unit] of jobs) {
      for (const id of structuresOf(world, this.team, kind, true)) {
        if (world.trainKind[id] === NO_TRAINING) enqueueTrain(world, id, unit)
      }
    }
  }

  /** Idle soldiers converge on any visible enemy near the hall. Returns true if defending. */
  private defend(world: World, hall: number, soldiers: number[]): boolean {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    let threat = NO_TARGET
    let nearest = DEFENSE_RADIUS
    for (const id of world.entities.keys()) {
      const kind = world.kind[id]
      if (kind !== KIND_WORKER && kind !== KIND_MELEE && kind !== KIND_RANGED) continue
      if (world.team[id] === this.team) continue
      if (!canSee(world, this.team, id)) continue
      const d = Math.hypot(world.positionX[id] - hx, world.positionZ[id] - hz)
      if (d < nearest) {
        nearest = d
        threat = id
      }
    }
    if (threat === NO_TARGET) return false
    const tx = world.positionX[threat]
    const tz = world.positionZ[threat]
    for (const id of soldiers) {
      if (world.state[id] !== STATE_IDLE) continue
      orderMove(world, id, tx, tz) // They engage anything in sight on the way.
    }
    return true
  }

  /** Once strong enough, idle soldiers march on the enemy hall (or search for it). */
  private attack(world: World, hall: number, soldiers: number[]): void {
    if (soldiers.length < ATTACK_ARMY) return
    const idle = soldiers.filter((id) => world.state[id] === STATE_IDLE)
    if (idle.length === 0) return
    const target = this.findTarget(world, hall, idle)
    if (target === null) return
    for (const id of idle) orderMove(world, id, target.x, target.z)
  }

  /** Where to send the army: the enemy hall if explored, else the mirror guess, else search. */
  private findTarget(
    world: World,
    hall: number,
    army: number[],
  ): { x: number; z: number } | null {
    const enemyTeam = (this.team === 0 ? 1 : 0) as 0 | 1
    const enemyHall = structuresOf(world, enemyTeam, KIND_HALL, false)[0]
    if (enemyHall !== undefined) {
      const ex = world.positionX[enemyHall]
      const ez = world.positionZ[enemyHall]
      if (isExplored(world, this.team, ex, ez)) return { x: ex, z: ez } // Seen it: attack.
    }
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const guess = { x: -hx, z: hz } // Mirror of our own start.
    if (!isExplored(world, this.team, guess.x, guess.z)) return guess

    // Nothing there: search the nearest unexplored point from the army's centre.
    let cx = 0
    let cz = 0
    for (const id of army) {
      cx += world.positionX[id]
      cz += world.positionZ[id]
    }
    cx /= army.length
    cz /= army.length
    let best: { x: number; z: number } | null = null
    let bestDist = Infinity
    for (const p of SEARCH_POINTS) {
      if (isExplored(world, this.team, p.x, p.z)) continue
      const d = Math.hypot(p.x - cx, p.z - cz)
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    return best
  }
}

/** Coarse grid over the map used when the enemy base has not been found. */
const SEARCH_POINTS: { x: number; z: number }[] = []
for (const x of [-60, -30, 0, 30, 60]) {
  for (const z of [-50, 0, 50]) SEARCH_POINTS.push({ x, z })
}

/**
 * Place an unbuilt structure, charging its cost immediately.
 * The caller sends a worker with orderBuild() to construct it.
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

function isAreaFree(world: World, x: number, z: number, radius: number): boolean {
  for (const id of world.entities.keys()) {
    if (world.radius[id] <= 0) continue
    const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z)
    if (d < world.radius[id] + radius + 1) return false
  }
  return true
}

function structuresOf(world: World, team: 0 | 1, kind: number, builtOnly: boolean): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind) continue
    if (world.team[id] !== team) continue
    if (world.health[id] <= 0) continue
    if (builtOnly && world.buildProgress[id] < world.buildTotal[id]) continue
    found.push(id)
  }
  return found
}

function unitsOf(world: World, team: 0 | 1, kind: number): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind) continue
    if (world.team[id] !== team) continue
    found.push(id)
  }
  return found
}
