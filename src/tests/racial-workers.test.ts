/**
 * Racial worker identity tests (v2.0 spec, section 2: "The Four Founding Races").
 *
 * Human Peasant: co-op build edge (buildRate 1.15).
 * Orc Drudge: heavy haul (carryMax 20).
 * Undead Husk: seed-warp (plants the bone-seed and walks away; the
 *   structure pulls itself up with no worker present).
 * Elf Gatherer: symbiotic harvest (sap-tapping never depletes the tree).
 */
import { World, TEAM_PLAYER, KIND_WORKER, STATE_BUILD, STATE_GATHER, STATE_IDLE } from '../core/World.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { FACTIONS } from '../data/factions.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('racial-workers: identity')

function makeWorld(faction: 'human' | 'orc' | 'undead' | 'elf'): World {
  const world = new World()
  world.factionOfTeam = [faction, faction]
  world.registerSystem(new GatherSystemImpl())
  return world
}

function spawnWorker(world: World): number {
  return world.spawnUnit('worker', TEAM_PLAYER, 0, 0).id
}

test('factions carry distinct worker names', () => {
  assertEqual(FACTIONS.human.units.worker, 'Peasant', 'human worker name')
  assertEqual(FACTIONS.orc.units.worker, 'Drudge', 'orc worker name')
  assertEqual(FACTIONS.undead.units.worker, 'Husk', 'undead worker name')
  assertEqual(FACTIONS.elf.units.worker, 'Gatherer', 'elf worker name')
})

test('drudge hauls double (carryMax 20)', () => {
  const world = makeWorld('orc')
  const id = spawnWorker(world)
  assertEqual(world.carryMax[id], 20, 'drudge carryMax')
  assertEqual(world.kind[id], KIND_WORKER, 'still a worker kind')
})

test('other races carry the standard load (carryMax 10)', () => {
  for (const faction of ['human', 'undead', 'elf'] as const) {
    const world = makeWorld(faction)
    const id = spawnWorker(world)
    assertEqual(world.carryMax[id], 10, `${faction} carryMax`)
  }
})

test('undead seed-warp: husk plants and walks away, site self-builds', () => {
  const world = makeWorld('undead')
  const husk = spawnWorker(world)
  const site = world.spawnBuilding('barracks', TEAM_PLAYER, 10, 10, false).id
  // Put the husk to work on the site (already arrived: skip movement).
  world.state[husk] = STATE_BUILD
  world.targetId[husk] = site
  world.moving[husk] = 0
  const total = world.buildTotal[site]

  // One tick: the husk plants the seed and leaves.
  world.update(STEP)
  assertEqual(world.state[husk], STATE_IDLE, 'husk walks away after planting')
  assertEqual(world.buildAuto[site], 1, 'site flagged for self-building')

  // Run the sim with no worker anywhere near: the site must still complete.
  for (let i = 0; i < 60 * 30; i += 1) {
    world.update(STEP)
    if (world.buildProgress[site] >= total) break
  }
  assert(world.buildProgress[site] >= total, 'seed-warp site completed alone')
  assertEqual(world.buildAuto[site], 0, 'self-build flag cleared on completion')
})

test('human builds faster than baseline (co-op edge)', () => {
  const human = makeWorld('human')
  const other = makeWorld('orc')
  const hSite = human.spawnBuilding('barracks', TEAM_PLAYER, 10, 10, false).id
  const oSite = other.spawnBuilding('barracks', TEAM_PLAYER, 10, 10, false).id
  for (const [world, site] of [[human, hSite], [other, oSite]] as const) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, 10, 10).id
    world.state[w] = STATE_BUILD
    world.targetId[w] = site
    world.moving[w] = 0
  }
  stepWorld(human, 60)
  stepWorld(other, 60)
  assert(
    human.buildProgress[hSite] > other.buildProgress[oSite],
    `human co-op edge: ${human.buildProgress[hSite].toFixed(2)} > ${other.buildProgress[oSite].toFixed(2)}`,
  )
})

test('elf sap-tap: harvesting wood never depletes the tree', () => {
  const world = makeWorld('elf')
  const gatherer = spawnWorker(world)
  const tree = world.spawnResource('wood', 5, 5).id
  const before = world.amount[tree]
  assert(before > 0, 'tree has wood')

  // Force the gatherer onto the tree with an empty pack and a ready swing.
  world.state[gatherer] = STATE_GATHER
  world.targetId[gatherer] = tree
  world.moving[gatherer] = 0
  world.gatherTimer[gatherer] = 10
  world.update(STEP)

  assert(world.carryAmount[gatherer] > 0, 'gatherer took sap')
  assertEqual(world.amount[tree], before, 'tree not depleted by sap-tapping')
})

test('non-elf workers deplete trees normally', () => {
  const world = makeWorld('human')
  const peasant = spawnWorker(world)
  const tree = world.spawnResource('wood', 5, 5).id
  const before = world.amount[tree]

  world.state[peasant] = STATE_GATHER
  world.targetId[peasant] = tree
  world.moving[peasant] = 0
  world.gatherTimer[peasant] = 10
  world.update(STEP)

  assert(world.amount[tree] < before, 'tree depleted by normal harvest')
})

test('gather system registered without seed-warp regressions on humans', () => {
  const world = makeWorld('human')
  const peasant = spawnWorker(world)
  const site = world.spawnBuilding('barracks', TEAM_PLAYER, 10, 10, false).id
  world.state[peasant] = STATE_BUILD
  world.targetId[peasant] = site
  world.moving[peasant] = 0
  world.update(STEP)
  // Human workers stay on the job (no seed-warp): still building, site not autonomous.
  assertEqual(world.state[peasant], STATE_BUILD, 'peasant keeps building')
  assertEqual(world.buildAuto[site], 0, 'no self-build flag for humans')
})
