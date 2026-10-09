import type { System, World } from '../core/World'
import { BUILDINGS } from '../data/buildings.ts'
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
const CARRY_MAX = 10
const ARRIVE_MARGIN = 0.8 // stand this far from the target's edge

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
          world.gatherTimer[id] += dt
          if (world.gatherTimer[id] < GATHER_TIME) break
          world.gatherTimer[id] = 0
          world.carryKind[id] = world.kind[node] === KIND_TREE ? CARRY_WOOD : CARRY_GOLD
          const taken = Math.min(
            GATHER_AMOUNT,
            CARRY_MAX - world.carryAmount[id],
            world.amount[node],
          )
          world.amount[node] -= taken
          world.carryAmount[id] += taken
          if (world.amount[node] <= 0) spentNodes.push(node)
          if (world.carryAmount[id] >= CARRY_MAX || world.amount[node] <= 0) {
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
          world.buildProgress[site] += dt
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
            world.state[id] = STATE_IDLE
            // Grant supply on completion (not on placement).
            const bkind = world.kind[site]
            if (bkind >= KIND_HALL && bkind <= KIND_FARM) {
              const btype = BUILDING_TYPE_BY_KIND[bkind]
              world.supplyCap[world.team[site]] += BUILDINGS[btype].supply
            }
          }
          break
        }
        default:
          break
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

/** Nearest stocked node, preferring the worker's harvest assignment (falls back to any). */
function nearestNode(world: World, id: number): number {
  const pref = world.harvestKind[id]
  const found = nearestNodeOf(world, id, pref)
  if (found !== NO_TARGET || pref === HARVEST_ANY) return found
  return nearestNodeOf(world, id, HARVEST_ANY)
}

function nearestNodeOf(world: World, id: number, want: number): number {
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  let best = NO_TARGET
  let bestDist = Infinity
  for (const other of world.entities.keys()) {
    const kind = world.kind[other]
    if (want === HARVEST_WOOD && kind !== KIND_TREE) continue
    if (want === HARVEST_GOLD && kind !== KIND_GOLDMINE) continue
    if (want === HARVEST_ANY && kind !== KIND_TREE && kind !== KIND_GOLDMINE) continue
    if (world.amount[other] <= 0) continue
    const d = Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz)
    if (d < bestDist) {
      bestDist = d
      best = other
    }
  }
  return best
}

/** Nearest finished hall of the worker's team, or NO_TARGET. */
function nearestBuiltHall(world: World, id: number): number {
  const team = world.team[id]
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  let best = NO_TARGET
  let bestDist = Infinity
  for (const other of world.entities.keys()) {
    if (world.kind[other] !== KIND_HALL) continue
    if (world.team[other] !== team) continue
    if (world.buildProgress[other] < world.buildTotal[other]) continue
    const d = Math.hypot(world.positionX[other] - px, world.positionZ[other] - pz)
    if (d < bestDist) {
      bestDist = d
      best = other
    }
  }
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
