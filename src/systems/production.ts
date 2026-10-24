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
  TRAIN_QUEUE_WAITING,
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
 * Production: each finished building trains one unit at a time in its
 * active slot, with a waiting queue behind it (cap MAX_TRAIN_QUEUE
 * items total per building). When the timer completes the unit spawns
 * at the building's edge, walks to the rally point, and the queue head
 * starts. Costs are charged when the item is queued (enqueueTrain);
 * cancelling an item refunds its full cost (cancelTrainActive /
 * cancelTrainQueued). Also ticks Orc in-place building upgrades
 * (upgradeLeft).
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
      // The queue head starts immediately in the freed slot — its cost
      // was charged when it was queued.
      promoteQueue(world, id)
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
  // Game-feel: tier upgrades finished silently until now; cue them like any
  // other building completion (visual-only; renderer drains it each frame).
  world.completionFlashes.push({ id, unit: false, team: world.team[id] as 0 | 1 })
  // Each tier adds 40% max HP; heal the building by the same proportion.
  const newMax = world.maxHealth[id] * 1.4
  const ratio = world.health[id] / world.maxHealth[id]
  world.maxHealth[id] = newMax
  world.health[id] = newMax * ratio
}

/**
 * Production queue cap per building (Montz-approved): at most
 * MAX_TRAIN_QUEUE items in production at once — the active slot plus
 * the waiting queue. Enqueue attempts past the cap are refused.
 */
export const MAX_TRAIN_QUEUE = 1 + TRAIN_QUEUE_WAITING // 8

const TYPE_BY_KIND: Record<number, UnitType> = {
  [KIND_WORKER]: 'worker',
  [KIND_MELEE]: 'melee',
  [KIND_RANGED]: 'ranged',
}

/** The charged price of one training item (faction cost modifier applied). */
function trainCostFor(world: World, team: number, type: UnitType): { gold: number; wood: number } {
  const mods = FACTIONS[world.factionOfTeam[team]].mods
  const def = getUnits()[type]
  return {
    gold: Math.round(def.cost.gold * mods.cost),
    wood: Math.round(def.cost.wood * mods.cost),
  }
}

/** Start `type` in the building's active slot (its cost is already paid). */
function beginTraining(world: World, buildingId: number, type: UnitType): void {
  const team = world.team[buildingId]
  const mods = FACTIONS[world.factionOfTeam[team]].mods
  const unitDef = getUnits()[type]
  world.trainKind[buildingId] = KIND_BY_UNIT[type]
  // Orc War-Hall: higher tiers muster troops faster.
  const tierBonus = world.factionOfTeam[team] === 'orc' ? Math.pow(0.85, world.tier[buildingId] - 1) : 1
  world.trainTotal[buildingId] = (unitDef.trainTicks / TICK_RATE) * mods.train * tierBonus
  world.trainLeft[buildingId] = world.trainTotal[buildingId]
}

function queueBase(buildingId: number): number {
  return buildingId * TRAIN_QUEUE_WAITING
}

/** Move the waiting queue's head into the active slot (already paid for). */
function promoteQueue(world: World, buildingId: number): void {
  const len = world.trainQueueLen[buildingId]
  if (len === 0) return
  const base = queueBase(buildingId)
  const kind = world.trainQueueKind[base]
  for (let i = 1; i < len; i += 1) {
    world.trainQueueKind[base + i - 1] = world.trainQueueKind[base + i]
  }
  world.trainQueueKind[base + len - 1] = NO_TRAINING
  world.trainQueueLen[buildingId] = len - 1
  beginTraining(world, buildingId, TYPE_BY_KIND[kind])
}

/**
 * Queue a unit at a finished building. The first item starts in the
 * active slot; further items wait in the queue (cap MAX_TRAIN_QUEUE
 * total). Every item's cost is charged when it is queued. Returns false
 * when the building can't train the type, is unfinished or mid-upgrade,
 * the queue is full, the team can't afford the item, or starting it
 * would exceed the supply cap. Faction cost/train-time modifiers apply.
 */
export function enqueueTrain(world: World, buildingId: number, type: UnitType): boolean {
  const kind = world.kind[buildingId]
  if (kind !== KIND_HALL && kind !== KIND_BARRACKS && kind !== KIND_ARCHERY && kind !== KIND_FARM) {
    return false
  }
  const def = BUILDINGS[BUILDING_TYPE_BY_KIND[kind]]
  if (!def.trains.includes(type)) return false
  if (world.buildProgress[buildingId] < world.buildTotal[buildingId]) return false
  if (world.upgradeLeft[buildingId] > 0) return false // mid-upgrade: no training

  const team = world.team[buildingId]
  const cost = trainCostFor(world, team, type)
  if (world.gold[team] < cost.gold || world.wood[team] < cost.wood) return false
  const unitDef = getUnits()[type]
  // Supply: units already in production (here and at every other
  // building of the team) count against the cap — see
  // productionCommittedSupply.
  if (
    world.supplyUsed[team] + productionCommittedSupply(world, team) + unitDef.popCost >
    world.supplyCap[team]
  ) {
    return false
  }

  const active = world.trainKind[buildingId] !== NO_TRAINING
  if (active && world.trainQueueLen[buildingId] >= TRAIN_QUEUE_WAITING) return false // queue full

  world.gold[team] -= cost.gold
  world.wood[team] -= cost.wood
  if (!active) {
    beginTraining(world, buildingId, type)
  } else {
    const len = world.trainQueueLen[buildingId]
    world.trainQueueKind[queueBase(buildingId) + len] = KIND_BY_UNIT[type]
    world.trainQueueLen[buildingId] = len + 1
  }
  return true
}

/** Refund one item's full cost to the building's team. */
function refundTrainItem(world: World, buildingId: number, type: UnitType): void {
  const team = world.team[buildingId]
  const cost = trainCostFor(world, team, type)
  world.gold[team] += cost.gold
  world.wood[team] += cost.wood
}

/**
 * Cancel the ACTIVE training item: full refund of its cost, the slot
 * frees, and the queue head (if any) starts immediately at its full
 * train time. Returns false when nothing is training.
 */
export function cancelTrainActive(world: World, buildingId: number): boolean {
  if (!world.entities.has(buildingId)) return false
  const kind = world.trainKind[buildingId]
  if (kind === NO_TRAINING) return false
  refundTrainItem(world, buildingId, TYPE_BY_KIND[kind])
  world.trainKind[buildingId] = NO_TRAINING
  world.trainLeft[buildingId] = 0
  world.trainTotal[buildingId] = 0
  promoteQueue(world, buildingId)
  return true
}

/**
 * Cancel a WAITING queue item by queue index (0 = next up): full
 * refund of its cost; the queue closes ranks behind it. Returns false
 * when the index is out of range.
 */
export function cancelTrainQueued(world: World, buildingId: number, index: number): boolean {
  if (!world.entities.has(buildingId)) return false
  const len = world.trainQueueLen[buildingId]
  if (index < 0 || index >= len) return false
  const base = queueBase(buildingId)
  refundTrainItem(world, buildingId, TYPE_BY_KIND[world.trainQueueKind[base + index]])
  for (let i = index + 1; i < len; i += 1) {
    world.trainQueueKind[base + i - 1] = world.trainQueueKind[base + i]
  }
  world.trainQueueKind[base + len - 1] = NO_TRAINING
  world.trainQueueLen[buildingId] = len - 1
  return true
}

/** Items in production at a building: active slot (0/1) + waiting queue. */
export function trainQueueCount(world: World, buildingId: number): number {
  if (!world.entities.has(buildingId)) return 0
  return (world.trainKind[buildingId] !== NO_TRAINING ? 1 : 0) + world.trainQueueLen[buildingId]
}

/**
 * Supply a team has already committed to units in production (active
 * slots + waiting queues across all its buildings). supplyUsed only
 * counts units that exist, so without this the train cap check let a
 * full queue promise units past the cap — they then spawned over it.
 * Queued units now count against the cap from the moment they are
 * queued (and stop counting when cancelled or completed-and-counted
 * in supplyUsed). Flagged as a semantics touch: it tightens the
 * pre-queue check, which only ever compared against spawned units.
 */
export function productionCommittedSupply(world: World, team: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.team[id] !== team) continue
    const active = world.trainKind[id]
    if (active !== NO_TRAINING) n += getUnits()[TYPE_BY_KIND[active]].popCost
    const base = queueBase(id)
    const len = world.trainQueueLen[id]
    for (let i = 0; i < len; i += 1) {
      n += getUnits()[TYPE_BY_KIND[world.trainQueueKind[base + i]]].popCost
    }
  }
  return n
}

/** Set where newly trained units from this building will gather. */
export function setRally(world: World, buildingId: number, x: number, z: number): void {
  const kind = world.kind[buildingId]
  if (kind !== KIND_HALL && kind !== KIND_BARRACKS && kind !== KIND_ARCHERY) return
  world.rallyX[buildingId] = x
  world.rallyZ[buildingId] = z
}

/** Read-only snapshot of a building's active training slot, for the UI. */
export interface TrainingState {
  /** Unit type in the slot ('worker' | 'melee' | 'ranged'). */
  type: UnitType
  /** Elapsed fraction 0..1 of the active item, from sim state. */
  fraction: number
  /** Seconds remaining on the active item, from sim state. */
  secondsLeft: number
  /** Total seconds the active item takes, from sim state. */
  secondsTotal: number
}

/**
 * What a building is training right now, read straight from world state
 * (trainKind / trainLeft / trainTotal) — never estimated from data
 * tables. Returns null when the active slot is empty.
 */
export function trainingStateFor(world: World, buildingId: number): TrainingState | null {
  if (!world.entities.has(buildingId)) return null
  const kind = world.trainKind[buildingId]
  if (kind === NO_TRAINING) return null
  const total = world.trainTotal[buildingId]
  const left = Math.max(0, world.trainLeft[buildingId])
  return {
    type: TYPE_BY_KIND[kind],
    fraction: total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0,
    secondsLeft: left,
    secondsTotal: total,
  }
}

/**
 * Items queued BEHIND the active training slot, in production order —
 * read straight from the sim's queue state (trainQueueKind /
 * trainQueueLen). Queue index i here is the index cancelTrainQueued
 * cancels.
 */
export function trainingQueueFor(world: World, buildingId: number): UnitType[] {
  const out: UnitType[] = []
  if (!world.entities.has(buildingId)) return out
  const len = world.trainQueueLen[buildingId]
  const base = queueBase(buildingId)
  for (let i = 0; i < len; i += 1) out.push(TYPE_BY_KIND[world.trainQueueKind[base + i]])
  return out
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
  // Game-feel: research is instant and previously finished with no cue at
  // all. Push the same visual-only completion flash buildings and trained
  // units already use (renderer drains it; never enters the lockstep hash).
  world.completionFlashes.push({ id: buildingId, unit: false, team })
  return true
}
