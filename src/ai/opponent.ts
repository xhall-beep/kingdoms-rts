import { BUILDINGS } from '../data/buildings.ts'
import { UNITS } from '../data/units.ts'
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
  KIND_GOLDMINE} from '../core/World'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderAttackMove } from '../systems/combat.ts'
import { orderMove } from '../systems/movement.ts'
import { enqueueTrain } from '../systems/production.ts'
import {
  BUILDING_TYPE_BY_KIND,
  placeStructure,
} from '../world/construction.ts'
import { canSee, isExplored } from '../world/visibility.ts'

const WOOD_SHARE = 0.4 // Fraction of workers assigned to wood (the rest mine gold).

export type AIDifficulty = 'easy' | 'normal' | 'hard'

interface DifficultyTuning {
  thinkEvery: number // seconds between decisions
  workerTarget: number
  workersBeforeArmy: number // economy first: no military buildings before this many workers
  attackArmy: number // soldiers needed before attacking
  defenseRadius: number // enemies this close to the hall pull the army home
}

/**
 * Difficulty handicaps. The AI always plays by the rules (same commands, costs
 * and build times as the player); difficulty only changes how fast and how
 * ambitiously it makes decisions.
 */
const DIFFICULTY: Record<AIDifficulty, DifficultyTuning> = {
  easy: { thinkEvery: 2.0, workerTarget: 7, workersBeforeArmy: 6, attackArmy: 8, defenseRadius: 20 },
  normal: { thinkEvery: 1.0, workerTarget: 10, workersBeforeArmy: 5, attackArmy: 5, defenseRadius: 28 },
  hard: { thinkEvery: 0.5, workerTarget: 12, workersBeforeArmy: 4, attackArmy: 4, defenseRadius: 36 },
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
  private readonly tuning: DifficultyTuning
  private timer = 0
  private gameTime = 0 // seconds elapsed
  private scoutId: number | null = null
  private scoutTargets: { x: number; z: number }[] = []

  constructor(team: 0 | 1, difficulty: AIDifficulty = 'normal') {
    this.team = team
    this.tuning = DIFFICULTY[difficulty]
  }

  update(world: World, dt: number): void {
    this.timer += dt
    this.gameTime += dt
    if (this.timer < this.tuning.thinkEvery) return
    this.timer = 0

    const team = this.team
    const hall = structuresOf(world, team, KIND_HALL, true)[0]
    if (hall === undefined) return // Defeated.

    const workers = unitsOf(world, team, KIND_WORKER)
    const soldiers = [...unitsOf(world, team, KIND_MELEE), ...unitsOf(world, team, KIND_RANGED)]

    this.trainWorkers(world, hall, workers.length)
    this.assignWorkers(world, workers)
    this.scout(world, hall, workers)
    this.expandBase(world, hall, workers)
    const reserveGold = this.expand(world, hall, workers)
    this.trainSoldiers(world, workers.length, reserveGold)
    if (!this.defend(world, hall, soldiers)) this.attack(world, hall, soldiers)
  }

  private trainWorkers(world: World, hall: number, workerCount: number): void {
    const queued = world.trainKind[hall] !== NO_TRAINING ? 1 : 0 // Single training slot.
    if (workerCount + queued < this.tuning.workerTarget) enqueueTrain(world, hall, 'worker')
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
   * Returns the gold cost to reserve from soldier training while saving
   * for the planned building (0 when nothing is planned).
   */
  /** Build a second Town Hall near untapped resources when the main base depletes. */
  private expandBase(world: World, _hall: number, workers: number[]): void {
    // Only consider expansion after 5 minutes, and only once
    if (this.gameTime < 300) return
    const halls = structuresOf(world, this.team, KIND_HALL, true)
    if (halls.length >= 2) return // Already expanded
    if (world.gold[this.team] < 400) return // Need savings for the hall

    // Find a gold mine far from our existing halls
    let best: number | null = null
    let bestDist = 60 // Minimum distance from existing halls
    for (const id of world.entities.keys()) {
      if (world.kind[id] !== KIND_GOLDMINE) continue
      if (world.amount[id] < 500) continue // Need a rich node
      let minHallDist = Infinity
      for (const h of halls) {
        const d = Math.hypot(world.positionX[id] - world.positionX[h], world.positionZ[id] - world.positionZ[h])
        minHallDist = Math.min(minHallDist, d)
      }
      if (minHallDist > bestDist) {
        bestDist = minHallDist
        best = id
      }
    }

    if (best !== null) {
      // Send a worker to build a hall near this gold mine
      const gx = world.positionX[best]
      const gz = world.positionZ[best]
      const worker = workers.find((id) => world.state[id] === STATE_IDLE)
      if (worker !== undefined) {
        const placed = placeStructure(world, this.team, 'hall', gx + 10, gz + 10)
        if (placed.ok) {
          orderBuild(world, worker, placed.id)
        }
      }
    }
  }

  /** Send a worker to scout the map and find the enemy base. */
  private scout(world: World, hall: number, workers: number[]): void {
    // Only scout early game, and only if we don't know where the enemy is
    if (this.gameTime > 180) return // Stop scouting after 3 minutes
    const enemyTeam = (this.team === 0 ? 1 : 0) as 0 | 1
    const enemyHall = structuresOf(world, enemyTeam, KIND_HALL, false)[0]
    if (enemyHall !== undefined) {
      const ex = world.positionX[enemyHall]
      const ez = world.positionZ[enemyHall]
      if (isExplored(world, this.team, ex, ez)) return // Already found them
    }

    // Check if our scout is still alive and scouting
    if (this.scoutId !== null) {
      if (!world.entities.has(this.scoutId) || world.health[this.scoutId] <= 0) {
        this.scoutId = null
      } else if (world.state[this.scoutId] === STATE_IDLE && this.scoutTargets.length > 0) {
        // Scout arrived, send to next target
        const t = this.scoutTargets.shift()!
        orderMove(world, this.scoutId, t.x, t.z)
        return
      } else if (world.state[this.scoutId] !== STATE_IDLE) {
        return // Still moving
      }
    }

    // Need a new scout
    if (this.scoutId === null && workers.length >= 3 && this.scoutTargets.length === 0) {
      // Generate scout targets (map corners and center)
      const hx = world.positionX[hall]
      const hz = world.positionZ[hall]
      // Scout away from our base
      this.scoutTargets = [
        { x: -hx, z: -hz }, // Mirror position (likely enemy base)
        { x: -hx * 0.5, z: hz * 0.5 },
        { x: hx * 0.5, z: -hz * 0.5 },
      ]
      // Pick a worker (not the one building)
      const scout = workers.find((id) => world.state[id] === STATE_IDLE)
      if (scout !== undefined) {
        this.scoutId = scout
        const t = this.scoutTargets.shift()!
        orderMove(world, scout, t.x, t.z)
      }
    }
  }

  private expand(world: World, hall: number, workers: number[]): number {
    const team = this.team
    const all = (kind: number): number => structuresOf(world, team, kind, false).length
    const pending = (kind: number): number => all(kind) - structuresOf(world, team, kind, true).length
    const slack = world.supplyCap[team] - world.supplyUsed[team]
    const ready = workers.length >= this.tuning.workersBeforeArmy

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
    if (want === null) return 0
    const type = BUILDING_TYPE_BY_KIND[want]
    this.build(world, hall, want, workers)
    return BUILDINGS[type].cost.gold
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

  private trainSoldiers(world: World, workerCount: number, reserveGold: number): void {
    if (workerCount < this.tuning.workersBeforeArmy) return
    const jobs: [number, 'melee' | 'ranged'][] = [
      [KIND_BARRACKS, 'melee'],
      [KIND_ARCHERY, 'ranged'],
    ]
    for (const [kind, unit] of jobs) {
      for (const id of structuresOf(world, this.team, kind, true)) {
        if (world.trainKind[id] !== NO_TRAINING) continue
        // Don't spend the gold reserved for the planned building.
        const cost = UNITS[unit].cost.gold
        if (world.gold[this.team] - reserveGold < cost) continue
        enqueueTrain(world, id, unit)
      }
    }
  }

  /** Idle soldiers converge on any visible enemy near the hall. Returns true if defending. */
  private defend(world: World, hall: number, soldiers: number[]): boolean {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    let threat = NO_TARGET
    let nearest = this.tuning.defenseRadius
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
      orderAttackMove(world, id, tx, tz)
    }
    return true
  }

  /** Once strong enough, idle soldiers march on the enemy hall (or search for it). */
  private attack(world: World, hall: number, soldiers: number[]): void {
    const forced = this.gameTime > 240 && soldiers.length >= 3 // 4 min: attack with what you have
    if (!forced && soldiers.length < this.tuning.attackArmy) return
    const idle = soldiers.filter((id) => world.state[id] === STATE_IDLE)
    if (idle.length === 0) return
    const target = this.findTarget(world, hall, idle)
    if (target === null) return
    for (const id of idle) orderAttackMove(world, id, target.x, target.z)
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
