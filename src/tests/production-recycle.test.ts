/**
 * Stale production slots across entity recycling — regression tests for
 * the Tester charter 2026-10-26 attacks A3c + F2 (deploy-blocking).
 *
 * Root cause: World.removeEntity cleared the WAITING train queue but
 * never the ACTIVE slot (trainKind/trainLeft/trainTotal) or the tier
 * timer (upgradeLeft), and createEntity/spawnUnit never reset them
 * either. ProductionSystemImpl.update ticks those slots for ANY live
 * entity, so when a barracks died mid-training (or mid-tier-upgrade)
 * and its id was recycled (LIFO) by the next spawn anywhere, the dead
 * building's timer fired on the new entity: a phantom unit spawned
 * beside a worker at the worker's position for the worker's team, and
 * a recycled worker received a tier-upgrade's x1.4 maxHealth and tier.
 *
 * The fix clears the whole per-entity pending-state class at the
 * lifecycle gates (removeEntity + createEntity) and kind-gates the
 * production system's tick loop to buildings.
 *
 * These tests use a production-only world (the charter's repro shape):
 * staging trainLeft/upgradeLeft near zero is the "destroyed near
 * completion" case shortened — the slot persists for whatever time
 * remains in live play.
 */
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import {
  World,
  TEAM_PLAYER,
  KIND_WORKER,
  KIND_MELEE,
  NO_TRAINING,
} from '../core/World.ts'
import { stepWorld } from './setup.ts'
import {
  ProductionSystemImpl,
  enqueueTrain,
  upgradeBuilding,
} from '../systems/production.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'

function productionWorld(): World {
  const world = new World()
  world.registerSystem(new ProductionSystemImpl())
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  world.supplyCap[TEAM_PLAYER] = 200
  return world
}

function countKind(world: World, kind: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind) n += 1
  }
  return n
}

suite('recycled ids: stale production slots (A3c/F2)')

test('barracks dies mid-training: the recycled id spawns no phantom unit', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  assert(enqueueTrain(world, barracks.id, 'melee'), 'melee starts training')
  world.trainLeft[barracks.id] = 0.05 // destroyed near completion
  world.removeEntityById(barracks.id)
  assertEqual(world.trainKind[barracks.id], NO_TRAINING, 'active slot cleared at removal')
  assertEqual(world.trainLeft[barracks.id], 0, 'train timer cleared at removal')
  assertEqual(world.trainTotal[barracks.id], 0, 'train total cleared at removal')

  const worker = world.spawnUnit('worker', TEAM_PLAYER, 60, 60)
  assertEqual(worker.id, barracks.id, 'the spawn recycles the dead barracks id (LIFO)')
  const supplyAfterSpawn = world.supplyUsed[TEAM_PLAYER]
  stepWorld(world, 30)
  assertEqual(countKind(world, KIND_MELEE), 0, 'no phantom melee beside the worker')
  assertEqual(world.entities.size, 1, 'only the recycled worker exists')
  assertEqual(world.supplyUsed[TEAM_PLAYER], supplyAfterSpawn, 'no phantom supply charge')
})

test('barracks dies mid-tier-upgrade: the recycled worker keeps its own stats', () => {
  const world = productionWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  assert(upgradeBuilding(world, barracks.id), 'tier upgrade starts')
  world.upgradeLeft[barracks.id] = 0.05 // destroyed near completion
  world.removeEntityById(barracks.id)
  assertEqual(world.upgradeLeft[barracks.id], 0, 'upgrade timer cleared at removal')

  const worker = world.spawnUnit('worker', TEAM_PLAYER, 60, 60)
  assertEqual(worker.id, barracks.id, 'the spawn recycles the dead barracks id')
  const maxHp = world.maxHealth[worker.id]
  const hp = world.health[worker.id]
  stepWorld(world, 30)
  assertEqual(world.maxHealth[worker.id], maxHp, 'no x1.4 tier health on a worker')
  assertEqual(world.health[worker.id], hp, 'health untouched by the dead upgrade')
  assertEqual(world.tier[worker.id], 1, 'no tier inherited by a worker')
})

test('hall dies mid-training: the recycled id spawns no phantom worker', () => {
  const world = productionWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  assert(enqueueTrain(world, hall.id, 'worker'), 'worker starts training')
  world.trainLeft[hall.id] = 0.05
  world.removeEntityById(hall.id)

  const melee = world.spawnUnit('melee', TEAM_PLAYER, 60, 60)
  assertEqual(melee.id, hall.id, 'the spawn recycles the dead hall id')
  const supplyAfterSpawn = world.supplyUsed[TEAM_PLAYER]
  stepWorld(world, 30)
  assertEqual(countKind(world, KIND_WORKER), 0, 'no phantom worker beside the melee')
  assertEqual(world.entities.size, 1, 'only the recycled melee exists')
  assertEqual(world.supplyUsed[TEAM_PLAYER], supplyAfterSpawn, 'no phantom supply charge')
})

test('hall dies mid-tier-upgrade: the recycled unit keeps its own stats', () => {
  const world = productionWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  assert(upgradeBuilding(world, hall.id), 'War-Hall upgrade starts')
  world.upgradeLeft[hall.id] = 0.05
  world.removeEntityById(hall.id)

  const melee = world.spawnUnit('melee', TEAM_PLAYER, 60, 60)
  assertEqual(melee.id, hall.id, 'the spawn recycles the dead hall id')
  const maxHp = world.maxHealth[melee.id]
  stepWorld(world, 30)
  assertEqual(world.maxHealth[melee.id], maxHp, 'no x1.4 tier health on a melee unit')
  assertEqual(world.tier[melee.id], 1, 'no tier inherited by a unit')
})

test('hall dies with a full queue: nothing leaks — not the active slot, not the queue (Chaos bound)', () => {
  // Chaos fuzz 2026-10-26 (match 5 + probe-queueleak): the leak is
  // bounded to the ACTIVE slot only — pre-fix, a hall destroyed with
  // 1 active + 2 queued produced exactly 1 free unit; the waiting
  // queue behind the slot never leaked. Post-fix the bound is zero.
  const world = productionWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  assert(enqueueTrain(world, hall.id, 'worker'), 'first worker starts training')
  assert(enqueueTrain(world, hall.id, 'worker'), 'second worker queues')
  assert(enqueueTrain(world, hall.id, 'worker'), 'third worker queues')
  assertEqual(world.trainQueueLen[hall.id], 2, 'two workers wait behind the active slot')
  world.trainLeft[hall.id] = 0.05 // destroyed near completion (match 5 froze at fraction 0.179)
  world.removeEntityById(hall.id)
  assertEqual(world.trainKind[hall.id], NO_TRAINING, 'active slot cleared at removal')
  assertEqual(world.trainQueueLen[hall.id], 0, 'waiting queue cleared at removal')

  // The match-5 recipient shape: another building takes the id (there,
  // a team-0 hall under construction wearing a team-1 hall's ghost).
  // The command card's training readout is driven by exactly these
  // slots — all clean, so no phantom "Training…" readout, and no
  // bonus unit when the dead timer would have expired.
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 60, 60, true)
  assertEqual(barracks.id, hall.id, 'the barracks recycles the dead hall id')
  assertEqual(world.trainKind[barracks.id], NO_TRAINING, 'no ghost training state on the recycled building')
  assertEqual(world.trainLeft[barracks.id], 0, 'no ghost training countdown on the recycled building')
  assertEqual(world.trainQueueLen[barracks.id], 0, 'no ghost queue on the recycled building')
  const supplyAfterSpawn = world.supplyUsed[TEAM_PLAYER]
  stepWorld(world, 30)
  assertEqual(countKind(world, KIND_WORKER), 0, 'no free worker from the dead hall’s slot or queue')
  assertEqual(world.entities.size, 1, 'only the recycled barracks exists')
  assertEqual(world.supplyUsed[TEAM_PLAYER], supplyAfterSpawn, 'no phantom supply charge')
})

test('control: a live barracks still trains and upgrades to completion', () => {
  const world = productionWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  const baseMax = world.maxHealth[barracks.id]
  assert(enqueueTrain(world, barracks.id, 'melee'), 'melee queued')
  stepWorld(world, 60 * 30)
  assertEqual(countKind(world, KIND_MELEE), 1, 'the trained melee spawns beside its barracks')
  assertEqual(world.supplyUsed[TEAM_PLAYER], 2, 'supply charged for the trained melee')

  assert(upgradeBuilding(world, barracks.id), 'tier upgrade starts on the live barracks')
  stepWorld(world, 60 * 25)
  assertEqual(world.tier[barracks.id], 2, 'the live barracks reaches tier 2')
  assertClose(world.maxHealth[barracks.id], baseMax * 1.4, 0.01, 'tier health lands on the building')
})

suite('recycled ids: sibling residue slots')

test('a dead militia worker’s id does not make its replacement militia', () => {
  const world = productionWorld()
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  world.militiaUntil[worker.id] = 1000 // mustered, far from expiry (matchTime 0)
  assert(world.isMilitia(worker.id), 'the original worker is militia')
  world.removeEntityById(worker.id)
  const fresh = world.spawnUnit('worker', TEAM_PLAYER, 5, 5)
  assertEqual(fresh.id, worker.id, 'id recycled')
  assert(!world.isMilitia(fresh.id), 'the replacement worker is not militia')
  assertEqual(world.militiaUntil[fresh.id], 0, 'militia expiry cleared')
})

test('a dead seed-warp site’s buildAuto does not fire on the recycled id', () => {
  const world = new World()
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new GatherSystemImpl())
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  world.supplyCap[TEAM_PLAYER] = 200
  const site = world.spawnBuilding('farm', TEAM_PLAYER, 0, 0, false) // under construction
  world.buildAuto[site.id] = 1 // undead seed-warp in progress
  world.removeEntityById(site.id)
  assertEqual(world.buildAuto[site.id], 0, 'buildAuto cleared at removal')

  const worker = world.spawnUnit('worker', TEAM_PLAYER, 60, 60)
  assertEqual(worker.id, site.id, 'id recycled')
  const hp = world.health[worker.id]
  stepWorld(world, 30)
  assertEqual(world.health[worker.id], hp, 'no construction health math on a worker')
  assertEqual(world.buildProgress[worker.id], 0, 'no construction progress on a worker')
})

test('a dead worker’s cargo and orders do not pass to its replacement', () => {
  const world = productionWorld()
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  world.carryKind[worker.id] = 1
  world.carryAmount[worker.id] = 10
  world.moving[worker.id] = 1
  world.targetX[worker.id] = 42
  world.targetZ[worker.id] = -42
  world.removeEntityById(worker.id)
  const fresh = world.spawnUnit('worker', TEAM_PLAYER, 5, 5)
  assertEqual(fresh.id, worker.id, 'id recycled')
  assertEqual(world.carryAmount[fresh.id], 0, 'no phantom cargo')
  assertEqual(world.carryKind[fresh.id], 0, 'no phantom cargo kind')
  assertEqual(world.moving[fresh.id], 0, 'no inherited move order')
  assertEqual(world.targetX[fresh.id], 0, 'no inherited move target')
})

suite('recycled ids: legacy saves cannot resurrect the ghost')

/**
 * The staging below writes the stale slots directly onto a live
 * entity. That is not a shortcut around the bug — it is exactly the
 * entity row a PRE-FIX build's save carries: in the defective build
 * the worker/farm below recycled a dead barracks' id in play, and
 * trainKind/trainLeft are registry-serialized, so the ghost rides
 * through the save verbatim (Edge ledger 2026-10-26 §6). The load
 * path (World.scrubRestoredState) is what must refuse it.
 */
function roundTrip(worldA: World): World {
  const save = serializeWorld(worldA, 0, [])
  const worldB = new World()
  worldB.registerSystem(new ProductionSystemImpl())
  deserializeWorld(worldB, save)
  return worldB
}

test('a stale train slot on a unit does not survive save/load', () => {
  const worldA = productionWorld()
  const worker = worldA.spawnUnit('worker', TEAM_PLAYER, 60, 60)
  worldA.trainKind[worker.id] = KIND_MELEE
  worldA.trainLeft[worker.id] = 0.05
  worldA.trainTotal[worker.id] = 5

  const worldB = roundTrip(worldA)
  assertEqual(worldB.trainKind[worker.id], NO_TRAINING, 'ghost slot scrubbed at load')
  const supply = worldB.supplyUsed[TEAM_PLAYER]
  stepWorld(worldB, 30)
  assertEqual(countKind(worldB, KIND_MELEE), 0, 'no phantom melee after load')
  assertEqual(worldB.supplyUsed[TEAM_PLAYER], supply, 'no phantom supply after load')
})

test('a stale upgrade timer on a unit does not survive save/load', () => {
  const worldA = productionWorld()
  const worker = worldA.spawnUnit('worker', TEAM_PLAYER, 60, 60)
  worldA.upgradeLeft[worker.id] = 0.05

  const worldB = roundTrip(worldA)
  assertEqual(worldB.upgradeLeft[worker.id], 0, 'ghost timer scrubbed at load')
  const maxHp = worldB.maxHealth[worker.id]
  stepWorld(worldB, 30)
  assertEqual(worldB.maxHealth[worker.id], maxHp, 'no tier health after load')
  assertEqual(worldB.tier[worker.id], 1, 'no tier after load')
})

test('a farm carrying a dead barracks’ train slot is scrubbed at load', () => {
  const worldA = productionWorld()
  const farm = worldA.spawnBuilding('farm', TEAM_PLAYER, 0, 0, true)
  worldA.trainKind[farm.id] = KIND_MELEE // a farm's menu has no training at all
  worldA.trainLeft[farm.id] = 0.05
  worldA.trainTotal[farm.id] = 5

  const worldB = roundTrip(worldA)
  assertEqual(worldB.trainKind[farm.id], NO_TRAINING, 'impossible slot scrubbed at load')
  stepWorld(worldB, 30)
  assertEqual(countKind(worldB, KIND_MELEE), 0, 'no free archer/melee out of the farm')
  assertEqual(worldB.supplyUsed[TEAM_PLAYER], 0, 'no phantom supply')
})

test('controls: honest mid-production saves restore and complete after load', () => {
  // A barracks legitimately mid-training keeps its item across the save.
  const worldA = productionWorld()
  const barracks = worldA.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  assert(enqueueTrain(worldA, barracks.id, 'melee'), 'melee training in the original')
  const worldB = roundTrip(worldA)
  assertEqual(worldB.trainKind[barracks.id], KIND_MELEE, 'honest training survives the load')
  stepWorld(worldB, 60 * 30)
  assertEqual(countKind(worldB, KIND_MELEE), 1, 'the honest item completes after load')

  // An orc barracks legitimately mid-upgrade keeps its timer.
  const worldC = productionWorld()
  worldC.factionOfTeam[TEAM_PLAYER] = 'orc'
  const hall = worldC.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  const baseMax = worldC.maxHealth[hall.id]
  assert(upgradeBuilding(worldC, hall.id), 'upgrade starts in the original')
  const worldD = roundTrip(worldC)
  assert(worldD.upgradeLeft[hall.id] > 0, 'honest upgrade timer survives the load')
  stepWorld(worldD, 60 * 25)
  assertEqual(worldD.tier[hall.id], 2, 'the honest upgrade completes after load')
  assertClose(worldD.maxHealth[hall.id], baseMax * 1.4, 0.01, 'tier health lands after load')

  // A worker's legitimate state — cargo and militia — is NOT scrubbed.
  const worldE = productionWorld()
  const carrier = worldE.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  worldE.carryKind[carrier.id] = 1
  worldE.carryAmount[carrier.id] = 10
  worldE.militiaUntil[carrier.id] = 1000
  const worldF = roundTrip(worldE)
  assertEqual(worldF.carryAmount[carrier.id], 10, 'cargo survives the load')
  assertEqual(worldF.carryKind[carrier.id], 1, 'cargo kind survives the load')
  assert(worldF.isMilitia(carrier.id), 'militia survives the load')
})
