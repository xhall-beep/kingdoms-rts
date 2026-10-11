import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { FACTIONS } from '../data/factions.ts'
import type { FactionId } from '../data/factions.ts'
import { RESOURCES } from '../data/resources.ts'
import type { ResourceKind } from './types.ts'
import { getUnits } from '../data/stats.ts'
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
export const STATE_PATROL = 7
export const STATE_HOLD = 8

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

export interface DamageNumber {
  x: number
  z: number
  amount: number
  team: number
  age: number
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

  /** Visual-only damage numbers; not part of sim state, not serialized. */
  damageNumbers: DamageNumber[] = []

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
  meleeDmgLvl: number[] = [0, 0]
  meleeHpLvl: number[] = [0, 0]
  rangedDmgLvl: number[] = [0, 0]
  supplyUsed: number[] = [0, 0]
  supplyCap: number[] = [0, 0]
  factionOfTeam: [FactionId, FactionId] = ['human', 'human']
  /** Simulation tick counter (for deterministic rolls). */
  tick = 0
  /** Remaining ticks for reanimated units (0 = not reanimated). */
  readonly reanimateTicks: Int32Array
  /** Consecutive ticks in combat (for Orc momentum). */
  readonly momentumTicks: Int32Array
  /** Last tick the unit was in combat (for momentum reset). */
  readonly lastCombatTick: Int32Array

  /** Match outcome: -1 = ongoing, 0 = player (team 0) wins, 1 = enemy wins. */
  winner: -1 | 0 | 1 = -1

  readonly entities = new Map<number, Entity>()
  readonly systems: System[] = []

  private nextEntityId = 1
  private readonly capacity: number
  /**
   * Recycled entity IDs, LIFO. Populated by removeEntity, consumed by
   * createEntity. Allocation order is deterministic: both lockstep peers
   * see the same removals/creations in the same order.
   */
  private readonly freeIds: number[] = []

  constructor(options: WorldOptions = {}) {
    this.capacity = options.capacity ?? 1_024
    const length = this.capacity
    this.positionX = new Float32Array(length)
    this.positionY = new Float32Array(length)
    this.positionZ = new Float32Array(length)
    this.velocityX = new Float32Array(length)
    this.velocityY = new Float32Array(length)
    this.velocityZ = new Float32Array(length)
    this.reanimateTicks = new Int32Array(length)
    this.momentumTicks = new Int32Array(length)
    this.lastCombatTick = new Int32Array(length).fill(-1000000)
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
    let id: number
    const recycled = this.freeIds.pop()
    if (recycled !== undefined) {
      id = recycled
    } else {
      if (this.nextEntityId > this.capacity) {
        throw new Error('World capacity exceeded')
      }
      id = this.nextEntityId++
    }

    const entity = { id } as Entity
    this.entities.set(entity.id, entity)
    this.reanimateTicks[id] = 0
    this.momentumTicks[id] = 0
    this.lastCombatTick[id] = -1000000
    return entity
  }

  /** Restore the id counter after loading a save (ids themselves are restored directly). */
  setNextEntityId(id: number): void {
    this.nextEntityId = id
  }

  /**
   * Rebuild the free-ID list after loading a save: every id below maxId
   * that isn't a live entity is recyclable. Pushed descending so pop()
   * yields the lowest free id first (deterministic).
   */
  rebuildFreeIds(maxId: number): void {
    this.freeIds.length = 0
    for (let id = maxId; id >= 1; id--) {
      if (!this.entities.has(id)) this.freeIds.push(id)
    }
  }

  /** Exposed for deterministic state hashing (future entity ids depend on it). */
  getNextEntityId(): number {
    return this.nextEntityId
  }

  /** Number of recycled IDs waiting for reuse (hashed for determinism). */
  getFreeIdCount(): number {
    return this.freeIds.length
  }

  removeEntity(entity: Entity): void {
    const id = entity.id
    const kind = this.kind[id]
    const team = this.team[id]
    if (kind === KIND_WORKER || kind === KIND_MELEE || kind === KIND_RANGED) {
      this.supplyUsed[team] -= getUnits()[UNIT_BY_KIND[kind]].popCost
    } else if (kind >= KIND_HALL && kind <= KIND_FARM) {
      // Only completed buildings granted supply.
      if (this.buildProgress[id] >= this.buildTotal[id]) {
        this.supplyCap[team] -= BUILDINGS[BUILDING_BY_KIND[kind]].supply
      }
    }
    // Clear cross-entity references BEFORE the id is recycled: a stale
    // targetId would otherwise silently retarget to the id's next owner.
    for (const other of this.entities.keys()) {
      if (other !== id && this.targetId[other] === id) {
        this.targetId[other] = NO_TARGET
      }
    }
    this.entities.delete(id)
    this.freeIds.push(id)
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
    this.tick++
    // Update Orc momentum: increment for units in combat, reset after gap
    for (let id = 0; id < this.momentumTicks.length; id++) {
      if (!this.entities.has(id)) continue
      const team = this.team[id] as 0 | 1
      const sig = FACTIONS[this.factionOfTeam[team]].signature?.momentum
      if (!sig) continue
      const ticksSinceCombat = this.tick - this.lastCombatTick[id]
      const resetTicks = Math.round(sig.resetSec * 60) // TICK_RATE=60
      if (ticksSinceCombat === 1) {
        // Was in combat last tick: build momentum
        this.momentumTicks[id]++
      } else if (ticksSinceCombat > resetTicks) {
        // Out of combat too long: reset
        this.momentumTicks[id] = 0
      }
    }
    // Expire reanimated units
    for (let id = 0; id < this.reanimateTicks.length; id++) {
      if (this.reanimateTicks[id] > 0 && this.entities.has(id)) {
        this.reanimateTicks[id]--
        if (this.reanimateTicks[id] === 0) {
          // Reanimated unit crumbles — remove without death effects
          this.reanimateTicks[id] = -1 // Mark as expired, skip re-roll
          this.removeEntityById(id)
        }
      }
    }
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
    const def = getUnits()[type]
    const mods = FACTIONS[this.factionOfTeam[team]].mods
    const entity = this.createEntity()
    const id = entity.id
    this.kind[id] = KIND_BY_UNIT[type]
    this.team[id] = team
    const hp = Math.round(def.hp * mods.hp)
    // Apply upgrade bonuses
    let bonusHp = 0
    let bonusDmg = 0
    if (type === 'melee') {
      bonusHp = this.meleeHpLvl[team] * 25
      bonusDmg = this.meleeDmgLvl[team] * 3
    } else if (type === 'ranged') {
      bonusDmg = this.rangedDmgLvl[team] * 3
    }
    this.health[id] = hp + bonusHp
    this.maxHealth[id] = hp + bonusHp
    this.damage[id] = def.damage * mods.damage + bonusDmg
    // Elf signature: ranged units get bonus range
    const woodland = FACTIONS[this.factionOfTeam[team]].signature?.woodland
    const rangeBonus = (woodland && type === 'ranged') ? woodland.rangeBonus : 0
    this.attackRange[id] = def.range + rangeBonus
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
    // Default rally points toward the map center so both teams' workers start
    // from symmetric positions. A fixed +z offset favored whichever team sat
    // at +z, handing it ~2.3x gold income in the first 25 seconds.
    this.rallyX[id] = x - Math.sign(x) * (def.radius + 4)
    this.rallyZ[id] = z - Math.sign(z) * (def.radius + 4)
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
