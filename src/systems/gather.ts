import type { System, World } from '../core/World'
import { FACTIONS } from '../data/factions.ts'
import { recordTreeHarvest } from './living-wild.ts'
import { buildingSupply } from '../data/buildings.ts'
import { BUILDING_TYPE_BY_KIND } from '../world/construction.ts'
import {
  CARRY_GOLD,
  CARRY_NONE,
  CARRY_WOOD,
  HARVEST_ANY,
  HARVEST_GOLD,
  HARVEST_OFF,
  HARVEST_WOOD,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_TREE,
  KIND_WORKER,
  NO_TARGET,
  STATE_BUILD,
  STATE_GATHER,
  STATE_IDLE,
  STATE_MOVE,
  STATE_RETURN,
} from '../core/World'

const GATHER_TIME = 0.8 // seconds per swing
const GATHER_AMOUNT = 2 // resource taken per swing
const ARRIVE_MARGIN = 0.8 // stand this far from the target's edge
/** Seed-warp self-construction rate (undead): progress per second with no worker. */
const SEED_WARP_RATE = 1.2

/**
 * Shared construction-completion handling: full health and supply grant.
 * Used by both worker construction and undead seed-warp self-building.
 */
function finishConstruction(world: World, site: number): void {
  // Grant supply on completion (not on placement).
  const bkind = world.kind[site]
  if (bkind >= KIND_HALL && bkind <= KIND_FARM) {
    const btype = BUILDING_TYPE_BY_KIND[bkind]
    world.supplyCap[world.team[site]] += buildingSupply(btype, world.factionOfTeam[world.team[site]])
  }
  // Game-feel: completion cue (visual-only; renderer drains it each frame).
  world.completionFlashes.push({ id: site, unit: false, team: world.team[site] as 0 | 1 })
}

/**
 * Tilled Farmland (human racial): finished farms quicken nearby labor —
 * workers within 12 world units of their team's farm work 15% faster.
 */
const FARM_AURA_RADIUS = 12
function nearFinishedFarm(world: World, id: number): boolean {
  if (world.factionOfTeam[world.team[id] as 0 | 1] !== 'human') return false
  const x = world.positionX[id]
  const z = world.positionZ[id]
  for (const fid of world.entities.keys()) {
    if (world.kind[fid] !== KIND_FARM || world.team[fid] !== world.team[id]) continue
    if (world.buildProgress[fid] < world.buildTotal[fid]) continue
    const d = Math.hypot(world.positionX[fid] - x, world.positionZ[fid] - z)
    if (d <= FARM_AURA_RADIUS) return true
  }
  return false
}

/**
 * Worker FSM, adapted from the sim's workerStates:
 *   IDLE -> GATHER (walk to node, swing until full or node spent)
 *        -> RETURN (walk to hall, deposit, back to IDLE)
 *        -> BUILD  (walk to a construction site, add progress until done)
 * Idle workers gather on their own, so the economy runs headlessly.
 */
export class GatherSystemImpl implements System {
  update(world: World, dt: number): void {
    const spentNodes: number[] = []
    for (const id of world.entities.keys()) {
      if (world.kind[id] !== KIND_WORKER) continue
      switch (world.state[id]) {
        case STATE_IDLE: {
          if (world.carryAmount[id] > 0) {
            world.state[id] = STATE_RETURN
            sendToHall(world, id)
            break
          }
          // Militia Bell: levy pikemen hold their ground — they don't gather.
          if (world.isMilitia(id)) break
          // HARVEST_OFF: an explicit move order disarmed auto-gather; hold position.
          if (world.harvestKind[id] === HARVEST_OFF) break
          const node = nearestNode(world, id)
          if (node === NO_TARGET) break
          world.targetId[id] = node
          walkTo(world, id, node, ARRIVE_MARGIN)
          world.state[id] = STATE_GATHER
          break
        }
        case STATE_MOVE: {
          // Explicit move order finished: back to idle so auto-gather resumes.
          if (world.moving[id] === 0) world.state[id] = STATE_IDLE
          break
        }
        case STATE_GATHER: {
          const node = world.targetId[id]
          if (node === NO_TARGET || !world.entities.has(node) || world.amount[node] <= 0) {
            world.targetId[id] = NO_TARGET
            if (world.carryAmount[id] > 0) {
              world.state[id] = STATE_RETURN
              sendToHall(world, id)
            } else {
              world.state[id] = STATE_IDLE
            }
            break
          }
          if (world.moving[id] === 1) break // still walking there
          // Tilled Farmland: human workers near a finished farm swing 15% faster.
          const haste = nearFinishedFarm(world, id) ? 1.15 : 1
          // Faction gather modifier (mods.gather): the designed offset for
          // carry capacity — orc Drudges haul 20 per trip but swing 10%
          // slower. The modifier was declared with no consumer anywhere in
          // the sim (orc-human audit 2026-10-22), so the offset never
          // billed. Human/elf sit at 1.0 and are unaffected.
          const gatherMod = FACTIONS[world.factionOfTeam[world.team[id] as 0 | 1]].mods.gather
          world.gatherTimer[id] += dt * haste * gatherMod
          if (world.gatherTimer[id] < GATHER_TIME) break
          world.gatherTimer[id] = 0
          world.carryKind[id] = world.kind[node] === KIND_TREE ? CARRY_WOOD : CARRY_GOLD
          const carryMax = world.carryMax[id]
          const taken = Math.min(
            GATHER_AMOUNT,
            carryMax - world.carryAmount[id],
            world.amount[node],
          )
          // Elf symbiotic harvest: sap-tapping never depletes the tree.
          const sapTap = FACTIONS[world.factionOfTeam[world.team[id]]].worker.sapTap
          if (!sapTap) world.amount[node] -= taken
          // Living Wild: tearing wood from a tree feeds the team's wild
          // heat. Sap-tapping is symbiotic and angers nothing.
          if (world.kind[node] === KIND_TREE && !sapTap) {
            recordTreeHarvest(world, world.team[id] as 0 | 1, taken, node, id)
          }
          world.carryAmount[id] += taken
          if (world.amount[node] <= 0) spentNodes.push(node)
          if (world.carryAmount[id] >= carryMax || world.amount[node] <= 0) {
            world.state[id] = STATE_RETURN
            sendToHall(world, id)
          }
          break
        }
        case STATE_RETURN: {
          if (world.moving[id] === 1) break // still walking to the hall
          const team = world.team[id]
          if (world.carryKind[id] === CARRY_WOOD) world.wood[team] += world.carryAmount[id]
          else if (world.carryKind[id] === CARRY_GOLD) world.gold[team] += world.carryAmount[id]
          world.carryAmount[id] = 0
          world.carryKind[id] = CARRY_NONE
          world.state[id] = STATE_IDLE
          break
        }
        case STATE_BUILD: {
          const site = world.targetId[id]
          if (site === NO_TARGET || !world.entities.has(site)) {
            world.state[id] = STATE_IDLE
            break
          }
          if (world.buildProgress[site] >= world.buildTotal[site]) {
            world.state[id] = STATE_IDLE
            break
          }
          if (world.moving[id] === 1) break // still walking to the site
          const workerDef = FACTIONS[world.factionOfTeam[world.team[id]]].worker
          // Undead seed-warp: the Husk plants the bone-seed and walks away;
          // the structure pulls itself up from the earth on its own.
          if (workerDef.seedWarp) {
            world.buildAuto[site] = 1
            world.targetId[id] = NO_TARGET
            world.state[id] = STATE_IDLE
            break
          }
          // Tilled Farmland: human builders near a finished farm work 15% faster.
          const haste = nearFinishedFarm(world, id) ? 1.15 : 1
          world.buildProgress[site] += dt * workerDef.buildRate * haste
          const done = world.buildProgress[site] >= world.buildTotal[site]
          world.health[site] = done
            ? world.maxHealth[site]
            : Math.max(
                world.health[site],
                Math.floor(
                  (world.maxHealth[site] * world.buildProgress[site]) / world.buildTotal[site],
                ),
              )
          if (done) {
            finishConstruction(world, site)
            world.state[id] = STATE_IDLE
          }
          break
        }
        default:
          break
      }
    }
    // Seed-warp sites (undead) pull themselves up with no worker present.
    for (const id of world.entities.keys()) {
      if (world.buildAuto[id] !== 1) continue
      if (world.buildProgress[id] >= world.buildTotal[id]) {
        world.buildAuto[id] = 0
        continue
      }
      world.buildProgress[id] += dt * SEED_WARP_RATE
      const done = world.buildProgress[id] >= world.buildTotal[id]
      world.health[id] = done
        ? world.maxHealth[id]
        : Math.max(
            world.health[id],
            Math.floor((world.maxHealth[id] * world.buildProgress[id]) / world.buildTotal[id]),
          )
      if (done) {
        world.buildAuto[id] = 0
        finishConstruction(world, id)
      }
    }
    for (const node of spentNodes) world.removeEntityById(node)
  }
}

/** Walk toward an entity, stopping at its edge plus a margin. */
function walkTo(world: World, id: number, target: number, margin: number): void {
  world.targetX[id] = world.positionX[target]
  world.targetZ[id] = world.positionZ[target]
  world.stopDist[id] = world.radius[target] + margin
  world.moving[id] = 1
}

/** Nearest stocked node, preferring the worker's harvest assignment (falls back to any).
 * Uses the spatial hash with expanding search; crowded nodes (many workers
 * already targeting) are penalized so workers spread across the resource field
 * instead of piling onto one tree. Tie-broken by world order for determinism. */
function nearestNode(world: World, id: number): number {
  const pref = world.harvestKind[id]
  const found = nearestNodeOf(world, id, pref)
  if (found !== NO_TARGET || pref === HARVEST_ANY) return found
  return nearestNodeOf(world, id, HARVEST_ANY)
}

/** Crowding penalty in world units per worker already targeting the node. */
const CROWD_PENALTY = 20

/** Count same-team workers currently targeting (walking to or harvesting) a node. */
function countClaimants(world: World, nodeId: number, team: 0 | 1): number {
  let n = 0
  const nx = world.positionX[nodeId]
  const nz = world.positionZ[nodeId]
  world.spatialHash.forEachNear(nx, nz, (wid) => {
    if (world.kind[wid] !== KIND_WORKER) return
    if (world.team[wid] !== team) return
    if (world.targetId[wid] !== nodeId) return
    const st = world.state[wid]
    if (st === STATE_GATHER || st === STATE_IDLE || st === STATE_MOVE) n++
  })
  return n
}

function nearestNodeOf(world: World, id: number, want: number): number {
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const team = world.team[id] as 0 | 1
  const hash = world.spatialHash

  let best = NO_TARGET
  let bestScore = Infinity
  let bestSeq = Number.MAX_SAFE_INTEGER

  const consider = (other: number) => {
    const kind = world.kind[other]
    if (want === HARVEST_WOOD && kind !== KIND_TREE) return
    if (want === HARVEST_GOLD && kind !== KIND_GOLDMINE) return
    if (want === HARVEST_ANY && kind !== KIND_TREE && kind !== KIND_GOLDMINE) return
    if (world.amount[other] <= 0) return
    const d = Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz)
    const crowded = countClaimants(world, other, team)
    const score = d + crowded * CROWD_PENALTY
    const seq = hash.sequenceOf(other)
    if (score < bestScore || (score === bestScore && seq < bestSeq)) {
      bestScore = score
      bestSeq = seq
      best = other
    }
  }

  // Expanding rect search: 72, 144, 288 world units. Falls back to full scan
  // only if no node exists within 288 (larger than any map).
  for (const half of [36, 72, 144]) {
    hash.forEachInRect(px - half, pz - half, px + half, pz + half, consider)
    if (best !== NO_TARGET) return best
  }
  for (const other of world.entities.keys()) consider(other)
  return best
}

/** Nearest finished hall of the worker's team, or NO_TARGET. */
function nearestBuiltHall(world: World, id: number): number {
  const team = world.team[id]
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const hash = world.spatialHash
  let best = NO_TARGET
  let bestDist = Infinity
  let bestSeq = Number.MAX_SAFE_INTEGER
  const consider = (other: number) => {
    if (world.kind[other] !== KIND_HALL) return
    if (world.team[other] !== team) return
    if (world.buildProgress[other] < world.buildTotal[other]) return
    const d = Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz)
    const seq = hash.sequenceOf(other)
    if (d < bestDist || (d === bestDist && seq < bestSeq)) {
      bestDist = d
      bestSeq = seq
      best = other
    }
  }
  // Halls are few; a single 3x3 covers the base area. Fall back to full scan.
  hash.forEachNear(px, pz, consider)
  if (best !== NO_TARGET) return best
  for (const other of world.entities.keys()) consider(other)
  return best
}

function sendToHall(world: World, id: number): void {
  const hall = nearestBuiltHall(world, id)
  if (hall === NO_TARGET) {
    world.state[id] = STATE_IDLE
    return
  }
  world.targetId[id] = hall
  walkTo(world, id, hall, ARRIVE_MARGIN)
}

/** Order a worker to (re)start gathering. Carried resources are kept and delivered. */
export function orderGather(world: World, id: number): void {
  if (world.kind[id] !== KIND_WORKER) return
  world.moving[id] = 0
  world.state[id] = STATE_IDLE
}

/** Order a worker to construct an unfinished structure. */
export function orderBuild(world: World, workerId: number, siteId: number): void {
  if (world.kind[workerId] !== KIND_WORKER) return
  if (!world.entities.has(siteId)) return
  world.targetId[workerId] = siteId
  walkTo(world, workerId, siteId, ARRIVE_MARGIN)
  world.state[workerId] = STATE_BUILD
}
