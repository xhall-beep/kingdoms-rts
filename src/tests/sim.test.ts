/**
 * Core simulation regression tests — headless, deterministic.
 * Covers: construction, production, combat, movement, gathering, victory.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_WORKER } from '../core/World.ts'
import { placeStructure, canAfford } from '../world/construction.ts'
import { orderMove } from '../systems/movement.ts'
import { orderAttack, orderAttackMove } from '../systems/combat.ts'
import { orderGather, orderBuild } from '../systems/gather.ts'
import { enqueueTrain, setRally } from '../systems/production.ts'
import { BUILDINGS } from '../data/buildings.ts'
import { UNITS } from '../data/units.ts'
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

function freshWorld(): World {
  return makeWorld()
}

function playerUnits(world: World, kind: number): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === kind) out.push(id)
  }
  return out
}

function playerBuildings(world: World): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] >= 3 && world.kind[id] <= 6) out.push(id)
  }
  return out
}

// --- Construction ---

suite('construction')
test('placing a farm deducts cost', () => {
  const world = freshWorld()
  const goldBefore = world.gold[TEAM_PLAYER]
  const woodBefore = world.wood[TEAM_PLAYER]
  const cost = BUILDINGS.farm.cost
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 0, -40)
  assert(placed.ok, 'placement should succeed')
  assertEqual(world.gold[TEAM_PLAYER], goldBefore - cost.gold, 'gold deducted')
  assertEqual(world.wood[TEAM_PLAYER], woodBefore - cost.wood, 'wood deducted')
})

test('cannot afford building when broke', () => {
  const world = freshWorld()
  world.gold[TEAM_PLAYER] = 0
  world.wood[TEAM_PLAYER] = 0
  assert(!canAfford(world, TEAM_PLAYER, 'barracks'), 'should not afford barracks')
})

test('worker builds structure to completion', () => {
  const world = freshWorld()
  const workers = playerUnits(world, KIND_WORKER)
  assert(workers.length > 0, 'need a worker')
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 0, -40)
  assert(placed.ok, 'placement should succeed')
  orderBuild(world, workers[0], placed.id)
  // Farm build time: step until complete (generous timeout).
  stepWorld(world, 60 * 60)
  assert(
    world.buildProgress[placed.id] >= world.buildTotal[placed.id],
    'farm should be completed',
  )
})

test('unfinished building has partial progress', () => {
  const world = freshWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 0, -40)
  assert(placed.ok, 'placement should succeed')
  assert(
    world.buildProgress[placed.id] < world.buildTotal[placed.id],
    'new placement should be incomplete',
  )
})

// --- Production ---

suite('production')
test('training a worker deducts cost and spawns unit', () => {
  const world = freshWorld()
  const halls = playerBuildings(world).filter((id) => world.kind[id] === 3) // KIND_HALL
  assert(halls.length > 0, 'need a hall')
  const goldBefore = world.gold[TEAM_PLAYER]
  const cost = UNITS.worker.cost
  const ok = enqueueTrain(world, halls[0], 'worker')
  assert(ok, 'enqueue should succeed')
  assertEqual(world.gold[TEAM_PLAYER], goldBefore - cost.gold, 'gold deducted on train')
  const workersBefore = playerUnits(world, KIND_WORKER).length
  stepWorld(world, 60 * 30) // 30s should complete a 5s train
  const workersAfter = playerUnits(world, KIND_WORKER).length
  assert(workersAfter > workersBefore, 'worker should spawn after training')
})

test('supply cap blocks training', () => {
  const world = freshWorld()
  // Fill supply: spawn many units.
  for (let i = 0; i < 50; i += 1) {
    world.spawnUnit('worker', TEAM_PLAYER, -36 + (i % 10), -30 - Math.floor(i / 10))
  }
  const halls = playerBuildings(world).filter((id) => world.kind[id] === 3)
  const ok = enqueueTrain(world, halls[0], 'worker')
  assert(!ok, 'training should be blocked at supply cap')
})

test('rally point is set on building', () => {
  const world = freshWorld()
  const halls = playerBuildings(world).filter((id) => world.kind[id] === 3)
  setRally(world, halls[0], 10, 10)
  assertClose(world.rallyX[halls[0]], 10, 0.01, 'rally X set')
  assertClose(world.rallyZ[halls[0]], 10, 0.01, 'rally Z set')
})

// --- Movement ---

suite('movement')
test('move order relocates unit', () => {
  const world = freshWorld()
  const workers = playerUnits(world, KIND_WORKER)
  const id = workers[0]
  const startX = world.positionX[id]
  orderMove(world, id, startX + 20, world.positionZ[id])
  stepWorld(world, 60 * 10)
  assert(
    Math.abs(world.positionX[id] - (startX + 20)) < 3,
    'worker should arrive near destination',
  )
})

// --- Combat ---

suite('combat')
test('attack kills enemy unit', () => {
  const world = freshWorld()
  const meleeId = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const enemyId = world.spawnUnit('worker', TEAM_ENEMY, 2, 0).id
  orderAttack(world, meleeId, enemyId)
  stepWorld(world, 60 * 30)
  assert(!world.entities.has(enemyId), 'enemy worker should die')
  assert(world.entities.has(meleeId), 'attacker should survive')
})

test('attack-move engages enemy then resumes', () => {
  const world = freshWorld()
  const meleeId = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const enemyId = world.spawnUnit('worker', TEAM_ENEMY, 5, 0).id
  orderAttackMove(world, meleeId, 30, 0)
  stepWorld(world, 60 * 60)
  assert(!world.entities.has(enemyId), 'enemy should die to attack-move')
  // Should resume toward destination after kill.
  assert(world.positionX[meleeId] > 10, 'should resume march after engagement')
})

test('dead entities are cleaned up', () => {
  const world = freshWorld()
  const enemyId = world.spawnUnit('worker', TEAM_ENEMY, 0, 0).id
  world.health[enemyId] = 1
  const meleeId = world.spawnUnit('melee', TEAM_PLAYER, 1, 0).id
  orderAttack(world, meleeId, enemyId)
  stepWorld(world, 60 * 10)
  assert(!world.entities.has(enemyId), 'dead entity removed from world')
})

// --- Gathering ---

suite('gathering')
test('worker gathers wood and delivers', () => {
  const world = freshWorld()
  const workers = playerUnits(world, KIND_WORKER)
  const id = workers[0]
  // Find a tree near the player base.
  let treeId = -1
  for (const eid of world.entities.keys()) {
    if (world.kind[eid] === 7) {
      // KIND_TREE
      treeId = eid
      break
    }
  }
  assert(treeId !== -1, 'need a tree')
  const woodBefore = world.wood[TEAM_PLAYER]
  world.harvestKind[id] = 1 // HARVEST_WOOD
  orderGather(world, id)
  // Let the worker find the tree, harvest, and return (generous timeout).
  stepWorld(world, 60 * 120)
  assert(world.wood[TEAM_PLAYER] > woodBefore, 'wood should increase after gathering')
})

// --- Victory ---

suite('victory')
test('destroying enemy hall triggers victory', () => {
  const world = freshWorld()
  // Find and kill all enemy buildings.
  const enemyBuildings: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_ENEMY && world.kind[id] >= 3 && world.kind[id] <= 6) {
      enemyBuildings.push(id)
    }
  }
  assert(enemyBuildings.length > 0, 'enemy should have buildings')
  for (const id of enemyBuildings) {
    world.removeEntityById(id)
  }
  // Also remove enemy units so teamAlive is false.
  for (const id of [...world.entities.keys()]) {
    if (world.team[id] === TEAM_ENEMY) world.removeEntityById(id)
  }
  stepWorld(world, 60 * 2)
  assertEqual(world.winner, 0, 'player should win when enemy buildings destroyed')
})
