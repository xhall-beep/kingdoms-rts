import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { FACTIONS } from '../data/factions.ts'
import type { FactionId } from '../data/factions.ts'
import { RESOURCES } from '../data/resources.ts'
import type { ResourceKind } from './types.ts'
import { UNITS } from '../data/units.ts'
import type { UnitType } from '../data/units.ts'
import { TICK_RATE } from './time.ts'
import { FogGrid } from '../world/fog.ts'

// ---- entity kinds ----
export const KIND_WORKER = 0
export const KIND_MELEE = 1
export const KIND_RANGED = 2
export const KIND_HALL = 3
export const KIND_BARRACKS = 4
export const KIND_ARCHERY = 5
export const KIND_FARM = 6
export const KIND_TREE = 7
export const KIND_GOLDMINE = 8

// ---- unit states ----
export const STATE_IDLE = 0
export const STATE_MOVE = 1
export const STATE_GATHER = 2
export const STATE_RETURN = 3
export const STATE_ATTACK = 4
export const STATE_BUILD = 5
export const STATE_ATTACKMOVE = 6

export const TEAM_PLAYER = 0
export const TEAM_ENEMY = 1

export const NO_TARGET = -1
export const NO_TRAINING = -1

/** Carry kinds carried by workers: 0 = none, 1 = wood, 2 = gold. */
export const CARRY_NONE = 0
export const CARRY_WOOD = 1
export const CARRY_GOLD = 2

/** Worker harvest preference: 0 = nearest node, 1 = wood, 2 = gold. */
export const HARVEST_ANY = 0
export const HARVEST_WOOD = 1
export const HARVEST_GOLD = 2
export const HARVEST_OFF = 3 // auto-gather disarmed: worker holds position

const KIND_BY_UNIT: Record<UnitType, number> = {
  worker: KIND_WORKER,
  melee: KIND_MELEE,
  ranged: KIND_RANGED,
}

const KIND_BY_BUILDING: Record<BuildingType, number> = {
  hall: KIND_HALL,
  barracks: KIND_BARRACKS,
  archery: KIND_ARCHERY,
  farm: KIND_FARM,
}

const UNIT_BY_KIND: UnitType[] = ['worker', 'melee', 'ranged']

const BUILDING_BY_KIND: BuildingType[] = [
  'hall', 'hall', 'hall', // 0-2: units, unused
  'hall', 'barracks', 'archery', 'farm',
]

export interface Entity {
  readonly id: number
}

export interface System {
  update(world: World, deltaSeconds: number): void
}

export interface WorldOptions {
  capacity?: number
}

export class World {
  // ---- spatial (struct of arrays) ----
  readonly positionX: Float32Array
  readonly positionY: Float32Array
  readonly positionZ: Float32Array
  readonly velocityX: Float32Array
  readonly velocityY: Float32Array
  readonly velocityZ: Float32Array

  // ---- identity ----
  readonly kind: Uint8Array
  readonly team: Uint8Array
  readonly state: Uint8Array

  // ---- combat ----
  readonly health: Float32Array
  readonly maxHealth: Float32Array
  readonly damage: Float32Array
  readonly attackRange: Float32Array
  readonly sight: Float32Array
  readonly cooldown: Float32Array
  readonly cooldownTotal: Float32Array

  // ---- movement orders ----
  readonly moving: Uint8Array
  readonly moveSpeed: Float32Array
  readonly targetX: Float32Array
  readonly targetZ: Float32Array
  readonly stopDist: Float32Array
  readonly radius: Float32Array

  // ---- targeting ----
  readonly targetId: Int32Array

  // ---- workers ----
  readonly carryKind: Uint8Array
  readonly carryAmount: Float32Array
  readonly gatherTimer: Float32Array
  readonly amount: Float32Array // resource node stock

  // ---- construction ----
  readonly buildProgress: Float32Array
  readonly buildTotal: Float32Array

  // ---- production (single active training slot per building) ----
  readonly trainKind: Int8Array
  readonly trainLeft: Float32Array
  readonly trainTotal: Float32Array
  readonly rallyX: Float32Array
  readonly rallyZ: Float32Array

  // ---- fog of war (one grid per team) ----
  readonly fog: FogGrid[]

  // ---- worker harvest preference ----
  readonly harvestKind: Uint8Array

  // ---- attack-move destination (restored after each engagement) ----
  readonly resumeX: Float32Array
  readonly resumeZ: Float32Array

  // ---- economy & factions per team (index 0 = player, 1 = enemy) ----
  gold: number[] = [0, 0]
  wood: number[] = [0, 0]
  supplyUsed: number[] = [0, 0]
  supplyCap: number[] = [0, 0]
  factionOfTeam: [FactionId, FactionId] = ['human', 'human']

  /** Match outcome: -1 = ongoing, 0 = player (team 0) wins, 1 = enemy wins. */
  winner: -1 | 0 | 1 = -1

  readonly entities = new Map<number, Entity>()
  readonly systems: System[] = []

  private nextEntityId = 1
  private readonly capacity: number

  constructor(options: WorldOptions = {}) {
    this.capacity = options.capacity ?? 1_024
    const length = this.capacity
    this.positionX = new Float32Array(length)
    this.positionY = new Float32Array(length)
    this.positionZ = new Float32Array(length)
    this.velocityX = new Float32Array(length)
    this.velocityY = new Float32Array(length)
    this.velocityZ = new Float32Array(length)
    this.kind = new Uint8Array(length)
    this.team = new Uint8Array(length)
    this.state = new Uint8Array(length)
    this.health = new Float32Array(length)
    this.maxHealth = new Float32Array(length)
    this.damage = new Float32Array(length)
    this.attackRange = new Float32Array(length)
    this.sight = new Float32Array(length)
    this.cooldown = new Float32Array(length)
    this.cooldownTotal = new Float32Array(length)
    this.moving = new Uint8Array(length)
    this.moveSpeed = new Float32Array(length)
    this.targetX = new Float32Array(length)
    this.targetZ = new Float32Array(length)
    this.stopDist = new Float32Array(length)
    this.radius = new Float32Array(length)
    this.targetId = new Int32Array(length).fill(NO_TARGET)
    this.carryKind = new Uint8Array(length)
    this.carryAmount = new Float32Array(length)
    this.gatherTimer = new Float32Array(length)
    this.amount = new Float32Array(length)
    this.buildProgress = new Float32Array(length)
    this.buildTotal = new Float32Array(length)
    this.trainKind = new Int8Array(length).fill(NO_TRAINING)
    this.trainLeft = new Float32Array(length)
    this.trainTotal = new Float32Array(length)
    this.rallyX = new Float32Array(length)
    this.rallyZ = new Float32Array(length)
    this.fog = [new FogGrid(), new FogGrid()]
    this.harvestKind = new Uint8Array(length)
    this.resumeX = new Float32Array(length).fill(NaN)
    this.resumeZ = new Float32Array(length).fill(NaN)
  }

  createEntity(): Entity {
    if (this.nextEntityId > this.capacity) {
      throw new Error('World capacity exceeded')
    }

    const entity = { id: this.nextEntityId++ } as Entity
    this.entities.set(entity.id, entity)
    return entity
  }

  /** Restore the id counter after loading a save (ids themselves are restored directly). */
  setNextEntityId(id: number): void {
    this.nextEntityId = id
  }

  removeEntity(entity: Entity): void {
    const id = entity.id
    const kind = this.kind[id]
    const team = this.team[id]
    if (kind === KIND_WORKER || kind === KIND_MELEE || kind === KIND_RANGED) {
      this.supplyUsed[team] -= UNITS[UNIT_BY_KIND[kind]].popCost
    } else if (kind >= KIND_HALL && kind <= KIND_FARM) {
      // Only completed buildings granted supply.
      if (this.buildProgress[id] >= this.buildTotal[id]) {
        this.supplyCap[team] -= BUILDINGS[BUILDING_BY_KIND[kind]].supply
      }
    }
    this.entities.delete(id)
  }

  removeEntityById(id: number): void {
    const entity = this.entities.get(id)
    if (entity !== undefined) {
      this.removeEntity(entity)
    }
  }

  registerSystem(system: System): void {
    this.systems.push(system)
  }

  update(deltaSeconds: number): void {
    for (const system of this.systems) {
      system.update(this, deltaSeconds)
    }
  }

  setPosition(entity: Entity, x: number, y: number, z: number): void {
    this.positionX[entity.id] = x
    this.positionY[entity.id] = y
    this.positionZ[entity.id] = z
  }

  setVelocity(entity: Entity, x: number, y: number, z: number): void {
    this.velocityX[entity.id] = x
    this.velocityY[entity.id] = y
    this.velocityZ[entity.id] = z
  }

  getEntityCount(): number {
    return this.entities.size
  }

  /** Units and buildings can be attacked; resource nodes cannot. */
  isAttackable(id: number): boolean {
    return this.kind[id] <= KIND_FARM
  }

  snapshotSpatialState(): Float32Array[] {
    return [
      this.positionX.slice(),
      this.positionY.slice(),
      this.positionZ.slice(),
      this.velocityX.slice(),
      this.velocityY.slice(),
      this.velocityZ.slice(),
    ]
  }

  // ---- factories: build entities from the data tables (faction mods applied) ----

  spawnUnit(type: UnitType, team: 0 | 1, x: number, z: number): Entity {
    const def = UNITS[type]
    const mods = FACTIONS[this.factionOfTeam[team]].mods
    const entity = this.createEntity()
    const id = entity.id
    this.kind[id] = KIND_BY_UNIT[type]
    this.team[id] = team
    const hp = Math.round(def.hp * mods.hp)
    this.health[id] = hp
    this.maxHealth[id] = hp
    this.damage[id] = def.damage * mods.damage
    this.attackRange[id] = def.range
    this.sight[id] = def.sight
    this.cooldown[id] = 0
    this.cooldownTotal[id] = def.cooldownTicks / TICK_RATE
    this.moveSpeed[id] = def.speed * mods.speed * TICK_RATE
    this.radius[id] = 0.5
    this.state[id] = STATE_IDLE
    this.setPosition(entity, x, 0, z)
    this.supplyUsed[team] += def.popCost
    return entity
  }

  spawnBuilding(type: BuildingType, team: 0 | 1, x: number, z: number, built: boolean): Entity {
    const def = BUILDINGS[type]
    const entity = this.createEntity()
    const id = entity.id
    this.kind[id] = KIND_BY_BUILDING[type]
    this.team[id] = team
    this.health[id] = built ? def.hp : 1
    this.maxHealth[id] = def.hp
    this.radius[id] = def.radius
    this.sight[id] = def.sight
    this.buildTotal[id] = def.buildTicks / TICK_RATE
    this.buildProgress[id] = built ? this.buildTotal[id] : 0
    this.rallyX[id] = x
    this.rallyZ[id] = z + def.radius + 4
    this.state[id] = STATE_IDLE
    this.setPosition(entity, x, 0, z)
    if (built) this.supplyCap[team] += def.supply
    return entity
  }

  spawnResource(kind: ResourceKind, x: number, z: number): Entity {
    const def = RESOURCES[kind]
    const entity = this.createEntity()
    const id = entity.id
    this.kind[id] = kind === 'wood' ? KIND_TREE : KIND_GOLDMINE
    this.amount[id] = def.amount
    this.radius[id] = def.radius
    this.health[id] = 1
    this.maxHealth[id] = 1
    this.setPosition(entity, x, 0, z)
    return entity
  }
}
