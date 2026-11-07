import type { System, World } from '../core/World'
import { FACTIONS } from '../data/factions.ts'
import { recordTreeHarvest } from './living-wild.ts'
import { BUILDINGS, buildingSupply } from '../data/buildings.ts'
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
  KIND_PILE,
  KIND_TREE,
  KIND_WORKER,
  MILITIA_DURATION_SEC,
  NO_TARGET,
  PILE_PICKUP_RANGE,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  STATE_BUILD,
  STATE_DISARM,
  STATE_GATHER,
  STATE_HOLD,
  STATE_IDLE,
  STATE_MOVE,
  STATE_MUSTER,
  STATE_PATROL,
  STATE_RETURN,
  isBuildingKind,
} from '../core/World'

const GATHER_TIME = 0.8 // seconds per swing
const GATHER_AMOUNT = 2 // resource taken per swing
const ARRIVE_MARGIN = 0.8 // stand this far from the target's edge
/** Seed-warp self-construction rate (undead): progress per second with no worker. */
const SEED_WARP_RATE = 1.2
/**
 * Powerbuild crew curve (Warcraft 3 model): the first builder on a site
 * works at its full rate; every ADDITIONAL builder contributes this
 * fraction of its own rate. A uniform crew of n therefore builds at
 * 1 + 0.6·(n−1) × a lone builder's speed — help speeds a site up, but
 * never linearly. WC3's companion rule is also in force: each
 * additional builder pays a resource surcharge when it joins (see
 * POWERBUILD_SURCHARGE_RATE / buildSurchargeFor below).
 */
const POWERBUILD_EXTRA_FACTOR = 0.6
/**
 * Powerbuild surcharge (WC3 model, Montz-approved): each builder who
 * joins a site that ALREADY has a builder pays this fraction of the
 * structure's base cost, per resource, at the moment it joins. The
 * first builder is always free — including a replacement sent to an
 * orphaned site with nobody on it. No refund when a builder later
 * leaves, stops, or dies (v1 rule).
 */
const POWERBUILD_SURCHARGE_RATE = 0.15

/**
 * Shared construction-completion handling: full health and supply grant.
 * Used by both worker construction and undead seed-warp self-building.
 */
function finishConstruction(world: World, site: number): void {
  // Grant supply on completion (not on placement).
  const bkind = world.kind[site]
  if (isBuildingKind(bkind)) {
    const btype = BUILDING_TYPE_BY_KIND[bkind]
    world.supplyCap[world.team[site]] += buildingSupply(btype, world.factionOfTeam[world.team[site]])
  }
  // Game-feel: completion cue (visual-only; renderer drains it each frame).
  world.completionFlashes.push({ id: site, unit: false, team: world.team[site] as 0 | 1 })
  // Alert chip: see production.ts (off-screen gated in the HUD).
  world.pushCompletionAlert(site)
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
 *        -> RETURN (walk to hall — or any finished own building when
 *                   the hall is gone — deposit, back to IDLE)
 *        -> BUILD  (walk to a construction site, add progress until done)
 * Idle workers gather on their own, so the economy runs headlessly.
 */
export class GatherSystemImpl implements System {
  update(world: World, dt: number): void {
    const spentNodes: number[] = []
    /** Piles drained to exactly 0 by this tick's pickup pass; removed
     *  after every pass, never mid-iteration (the spentNodes pattern). */
    const drainedPiles: number[] = []
    pilePickupPass(world, drainedPiles)
    /**
     * Construction crews by site, collected during the worker pass and
     * applied in a single pass after it. Progress belongs to the
     * STRUCTURE, never to a worker: a builder who is stopped, killed, or
     * re-tasked mid-build leaves the site's progress exactly where it
     * was, and any worker ordered onto the site joins the crew.
     */
    const crews = new Map<number, { builders: number[]; rates: number[] }>()
    for (const id of world.entities.keys()) {
      if (world.kind[id] !== KIND_WORKER) continue
      // Militia Bell expiry (town-hall note §6): there is no expiry
      // event in the sim — isMilitia just goes false — so the return
      // order is issued here, before the state switch, on the first
      // tick the levy clock has lapsed. militiaUntil is cleared NOW, at
      // the order, so the field means exactly "armed service expiry"
      // and nothing can re-trigger. A pikeman still on duty (idle or a
      // combat stance) is ordered home to hand the pike in; a pikeman
      // the economy or a direct order already re-tasked mid-levy
      // (MOVE/GATHER/RETURN/BUILD) is only stood down in place — the
      // pass never yanks a worker out of a live work order.
      if (world.militiaUntil[id] > 0 && world.matchTime >= world.militiaUntil[id]) {
        world.militiaUntil[id] = 0
        const st = world.state[id]
        if (
          st === STATE_IDLE ||
          st === STATE_ATTACK ||
          st === STATE_ATTACKMOVE ||
          st === STATE_PATROL ||
          st === STATE_HOLD
        ) {
          const hall = nearestBuiltHall(world, id)
          if (hall === NO_TARGET) {
            // No finished hall anywhere: release in place — he is a
            // peasant where he stands, and nothing dangles.
            world.state[id] = STATE_IDLE
            world.targetId[id] = NO_TARGET
            world.moving[id] = 0
          } else {
            world.targetId[id] = hall
            walkTo(world, id, hall, ARRIVE_MARGIN)
            world.state[id] = STATE_DISARM
          }
        }
      }
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
          // Join the site's crew; the construction pass below applies
          // the crew's combined powerbuild rate once per tick.
          let crew = crews.get(site)
          if (!crew) {
            crew = { builders: [], rates: [] }
            crews.set(site, crew)
          }
          crew.builders.push(id)
          crew.rates.push(workerDef.buildRate * haste)
          break
        }
        case STATE_MUSTER: {
          // Town Hall arming trip (town-hall note §3). Destination
          // validity first — a destroyed (or id-recycled) hall
          // re-resolves down the ladder, and with no finished hall the
          // muster dissolves with the load still on his back.
          if (!retargetTrip(world, id)) break
          if (world.moving[id] === 1) break // still walking to the hall
          // Arrival → arm, in one step. Deposit with the RETURN case's
          // exact semantics (bank += amount, carry zeroed): a peasant
          // mustered mid-RETURN simply completes his delivery as part
          // of arming. Then stamp the levy — the 25 s runs from THIS
          // moment, per peasant (§4), never from the ring.
          const team = world.team[id]
          if (world.carryKind[id] === CARRY_WOOD) world.wood[team] += world.carryAmount[id]
          else if (world.carryKind[id] === CARRY_GOLD) world.gold[team] += world.carryAmount[id]
          world.carryAmount[id] = 0
          world.carryKind[id] = CARRY_NONE
          world.militiaUntil[id] = world.matchTime + MILITIA_DURATION_SEC
          world.state[id] = STATE_IDLE
          world.targetId[id] = NO_TARGET
          break
        }
        case STATE_DISARM: {
          // The trip home (town-hall note §6): same validity ladder as
          // the trip in. On arrival the pike is handed in — release to
          // an ordinary peasant at his hall. The release gates nothing
          // else, which is what makes abandoning the trip (a direct
          // player order overwriting the state) safe by construction.
          if (!retargetTrip(world, id)) break
          if (world.moving[id] === 1) break // still walking home
          world.state[id] = STATE_IDLE
          world.targetId[id] = NO_TARGET
          break
        }
        default:
          break
      }
    }
    // Construction pass: one progress application per site per tick, at
    // the crew's combined powerbuild rate (first builder full rate, each
    // additional builder at POWERBUILD_EXTRA_FACTOR of its own). Site
    // health tracks progress exactly as it did for a lone builder. On
    // completion every assigned builder releases to idle — the same
    // post-build state a single builder has always ended in. Builders
    // still walking to the site release via their STATE_BUILD case,
    // which sees progress >= total on the next tick.
    for (const [site, crew] of crews) {
      if (!world.entities.has(site)) continue
      if (world.buildProgress[site] >= world.buildTotal[site]) continue
      let combined = 0
      for (let i = 0; i < crew.rates.length; i += 1) {
        combined += i === 0 ? crew.rates[i] : crew.rates[i] * POWERBUILD_EXTRA_FACTOR
      }
      world.buildProgress[site] += dt * combined
      const done = world.buildProgress[site] >= world.buildTotal[site]
      world.health[site] = done
        ? world.maxHealth[site]
        : Math.max(
            world.health[site],
            Math.floor((world.maxHealth[site] * world.buildProgress[site]) / world.buildTotal[site]),
          )
      if (done) {
        finishConstruction(world, site)
        for (const wid of crew.builders) world.state[wid] = STATE_IDLE
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
    for (const pile of drainedPiles) world.removeEntityById(pile)
  }
}

/**
 * Militia Bell pile pickup pass — runs once per tick, before the worker
 * FSM, so a load picked up this tick feeds the same tick's FSM (an idle
 * worker who just recovered a pile goes RETURN at once and the FSM
 * carries the load home — the designed recovery).
 *
 * Rules (Anchor pile note 2026-11-06 §3, carried into the town-hall
 * note §8): own-team workers only — the team check is the whole
 * ownership rule, an enemy worker can NEVER take a pile; serving
 * militia are excluded (a levy standing on a casualty's pile does not
 * load up mid-stand); contact only, centre distance ≤
 * PILE_PICKUP_RANGE, no order, no state change, no rerouting — a
 * RETURN walker simply deposits more, a GATHER walker tops up en
 * route. Top-up is same-kind only and never exceeds the worker's free
 * capacity; a partial transfer leaves the exact remainder in the pile,
 * and a pile despawns only at exactly 0. Workers are processed in id
 * order and piles scanned in id order — if two workers are in range of
 * one pile, the lower worker id loads first. Deterministic by
 * construction.
 */
function pilePickupPass(world: World, drained: number[]): void {
  const workers: number[] = []
  const piles: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER) workers.push(id)
    else if (world.kind[id] === KIND_PILE) piles.push(id)
  }
  if (piles.length === 0) return
  workers.sort((a, b) => a - b)
  piles.sort((a, b) => a - b)
  for (const id of workers) {
    if (world.isMilitia(id)) continue
    const team = world.team[id]
    for (const pile of piles) {
      if (world.carryAmount[pile] <= 0) continue
      if (world.team[pile] !== team) continue
      const pileKind = world.carryKind[pile]
      // One load, one kind: a loaded worker takes only its own kind.
      if (world.carryAmount[id] > 0 && world.carryKind[id] !== pileKind) continue
      const free = world.carryMax[id] - world.carryAmount[id]
      if (free <= 0) break
      const d = Math.hypot(
        world.positionX[pile] - world.positionX[id],
        world.positionZ[pile] - world.positionZ[id],
      )
      if (d > PILE_PICKUP_RANGE) continue
      const moved = Math.min(world.carryAmount[pile], free)
      world.carryAmount[pile] -= moved
      world.carryKind[id] = pileKind
      world.carryAmount[id] += moved
      if (world.carryAmount[pile] === 0) drained.push(pile)
    }
  }
}

/** Walk toward an entity, stopping at its edge plus a margin. */
function walkTo(world: World, id: number, target: number, margin: number): void {
  world.targetX[id] = world.positionX[target]
  world.targetZ[id] = world.positionZ[target]
  world.stopDist[id] = world.radius[target] + margin
  world.moving[id] = 1
}

/**
 * Shared trip plumbing for STATE_MUSTER / STATE_DISARM (town-hall note
 * §3/§6). The destination (targetId) is valid while that entity exists,
 * is a KIND_HALL, and belongs to the peasant's team — kind and team,
 * not mere existence, because the id can be recycled mid-trip. The
 * muster hall need NOT be finished: the ring chose it, and arming and
 * deposit are abstract (the bank is not a physical inventory).
 *
 * An invalid destination re-resolves to the nearest FINISHED own hall
 * (the deposit path's own rule and tiebreak) and re-walks the trip.
 * With no finished own hall anywhere, the trip DISSOLVES: the peasant
 * is released to STATE_IDLE with any load still on his back — the
 * ordinary worker FSM takes him from there (carrying routes him to
 * RETURN, whose fallback lands the load at a finished building) — and
 * false is returned. No traveler or disarmer ever parks forever
 * waiting for a hall that isn't coming.
 */
function retargetTrip(world: World, id: number): boolean {
  const target = world.targetId[id]
  if (
    target !== NO_TARGET &&
    world.entities.has(target) &&
    world.kind[target] === KIND_HALL &&
    world.team[target] === world.team[id]
  ) {
    return true
  }
  const hall = nearestBuiltHall(world, id)
  if (hall === NO_TARGET) {
    world.state[id] = STATE_IDLE
    world.targetId[id] = NO_TARGET
    world.moving[id] = 0
    return false
  }
  world.targetId[id] = hall
  walkTo(world, id, hall, ARRIVE_MARGIN)
  return true
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
  // Hall gone (audit 2026-10-24, systems §1): a loaded worker with no
  // hall used to park forever — sendToHall set it back to IDLE with its
  // carry intact, and IDLE re-entered RETURN every tick without ever
  // moving. Fall back to the nearest finished own building of any kind
  // so the cargo still lands; the RETURN deposit on arrival is
  // target-agnostic, so no other path changes. When a hall exists this
  // fallback never runs and behaviour is byte-identical to before.
  const target = hall === NO_TARGET ? nearestFinishedOwnBuilding(world, id) : hall
  if (target === NO_TARGET) {
    world.state[id] = STATE_IDLE
    return
  }
  world.targetId[id] = target
  walkTo(world, id, target, ARRIVE_MARGIN)
}

/**
 * Nearest finished own building of any kind (the World.ts building
 * predicate: hall, barracks, archery, farm, tower, workshop, smithy),
 * or NO_TARGET. Same
 * deterministic tie-break as nearestBuiltHall: nearest, then lowest
 * spatial-hash sequence. Only used as the no-hall dropoff fallback.
 */
function nearestFinishedOwnBuilding(world: World, id: number): number {
  const team = world.team[id]
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const hash = world.spatialHash
  let best = NO_TARGET
  let bestDist = Infinity
  let bestSeq = Number.MAX_SAFE_INTEGER
  const consider = (other: number) => {
    const kind = world.kind[other]
    if (!isBuildingKind(kind)) return
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
  hash.forEachNear(px, pz, consider)
  if (best !== NO_TARGET) return best
  for (const other of world.entities.keys()) consider(other)
  return best
}

/** Order a worker to (re)start gathering. Carried resources are kept and delivered. */
export function orderGather(world: World, id: number): void {
  if (world.kind[id] !== KIND_WORKER) return
  world.moving[id] = 0
  world.state[id] = STATE_IDLE
}

/**
 * The flat powerbuild surcharge for joining this site as an ADDITIONAL
 * builder: 15% of the structure's base cost per resource, rounding UP
 * per resource (ceil — a nonzero base cost never surcharges zero),
 * charged once at the moment the builder joins. Zeroes for a missing
 * or finished site. Whether a given join actually pays depends on the
 * crew state — see buildSurchargeFor.
 */
export function buildSurchargeAmount(world: World, siteId: number): { gold: number; wood: number } {
  if (!world.entities.has(siteId)) return { gold: 0, wood: 0 }
  if (world.buildProgress[siteId] >= world.buildTotal[siteId]) return { gold: 0, wood: 0 }
  const kind = world.kind[siteId]
  const btype = BUILDING_TYPE_BY_KIND[kind]
  if (!btype) return { gold: 0, wood: 0 }
  const cost = BUILDINGS[btype].cost
  return {
    gold: Math.ceil(cost.gold * POWERBUILD_SURCHARGE_RATE),
    wood: Math.ceil(cost.wood * POWERBUILD_SURCHARGE_RATE),
  }
}

/**
 * The surcharge a NEW builder would pay to join this site right now:
 * the flat amount when a builder is already on the site, zero for the
 * first builder — a replacement sent to an orphaned site never pays.
 * Leaving or being stopped later refunds nothing (v1 rule). orderBuild
 * enforces this in the sim; the input layer reads these helpers to
 * pre-check deferred (lockstep) joins for feedback.
 */
export function buildSurchargeFor(world: World, siteId: number): { gold: number; wood: number } {
  if (buildersOnSite(world, siteId) === 0) return { gold: 0, wood: 0 }
  return buildSurchargeAmount(world, siteId)
}

/**
 * Order a worker to construct an unfinished structure. Joining a site
 * that already has a builder charges the joiner team's powerbuild
 * surcharge (buildSurchargeFor); when the team can't pay, the join is
 * refused — the worker keeps its current orders — and false is
 * returned so the caller can give feedback.
 */
export function orderBuild(world: World, workerId: number, siteId: number): boolean {
  if (world.kind[workerId] !== KIND_WORKER) return false
  if (!world.entities.has(siteId)) return false
  // Already building this site: re-issuing the order is a free no-op —
  // a builder never pays the surcharge twice for the same join.
  if (world.state[workerId] === STATE_BUILD && world.targetId[workerId] === siteId) return true
  const surcharge = buildSurchargeFor(world, siteId)
  if (surcharge.gold > 0 || surcharge.wood > 0) {
    const team = world.team[workerId]
    if (world.gold[team] < surcharge.gold || world.wood[team] < surcharge.wood) return false
    world.gold[team] -= surcharge.gold
    world.wood[team] -= surcharge.wood
  }
  world.targetId[workerId] = siteId
  walkTo(world, workerId, siteId, ARRIVE_MARGIN)
  world.state[workerId] = STATE_BUILD
  return true
}

/**
 * Workers currently assigned to a construction site (walking to it or
 * building on it). Read-only; the structure card shows the crew so the
 * multi-builder mechanic is visible instead of reading as a bug.
 */
export function buildersOnSite(world: World, siteId: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (
      world.kind[id] === KIND_WORKER &&
      world.state[id] === STATE_BUILD &&
      world.targetId[id] === siteId
    ) {
      n += 1
    }
  }
  return n
}
