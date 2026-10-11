/**
 * Tower Defense mode tests.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_HALL, KIND_TOWER } from '../core/World.ts'
import { BUILDINGS } from '../data/buildings.ts'
import {
  setupTowerDefense, spawnWave, updateTowerDefense,
  startWaveNow, waveComposition, TD_MAX_WAVES,
} from '../modes/tower-defense.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { World as WorldClass } from '../core/World.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { MovementSystemImpl } from '../systems/movement.ts'

/** Bare world without standard scenario (for TD mode tests). */
function makeBareWorld(): World {
  const world = new WorldClass()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

suite('tower-defense: setup')

test('tower building exists in data', () => {
  assert(BUILDINGS['tower'] !== undefined, 'tower building defined')
  assert(BUILDINGS['tower'].cost.gold > 0, 'tower has cost')
})

test('setup creates hall, workers, and resources', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 12345)

  let halls = 0, workers = 0
  for (const [id] of world.entities) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER) halls++
    if (world.kind[id] <= 2 && world.team[id] === TEAM_PLAYER) workers++
  }
  assertEqual(halls, 1, 'one player hall')
  assert(workers >= 3, 'starting workers')
  assert(world.gold[TEAM_PLAYER] > 0, 'starting gold')
  assertEqual(state.mode, 'build', 'starts in build phase')
  assertEqual(state.wave, 0, 'wave 0 initially')
})

test('tower gets combat stats on spawn', () => {
  const world = makeBareWorld()
  const tower = world.spawnBuilding('tower', TEAM_PLAYER, 10, 10, true)
  assertEqual(world.kind[tower.id], KIND_TOWER, 'is tower kind')
  assert(world.damage[tower.id] > 0, 'tower has damage')
  assert(world.attackRange[tower.id] > 0, 'tower has range')
})

suite('tower-defense: waves')

test('wave composition scales with wave number', () => {
  const [m1, r1] = waveComposition(1)
  const [m5, r5] = waveComposition(5)
  const [m10] = waveComposition(10)
  assert(m5 > m1, 'wave 5 has more melee than wave 1')
  assert(m10 > m5, 'wave 10 has more melee than wave 5')
  assert(r1 === 0, 'wave 1 has no ranged')
  assert(r5 > 0, 'wave 5 has ranged')
})

test('spawnWave creates enemies', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 999)
  state.wave = 1
  spawnWave(world, state)

  let enemies = 0
  for (const [id] of world.entities) {
    if (world.team[id] === TEAM_ENEMY) enemies++
  }
  const [m, r] = waveComposition(1)
  assertEqual(enemies, m + r, 'correct enemy count')
  assertEqual(state.mode, 'wave', 'mode is wave')
})

test('startWaveNow skips build phase', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 111)
  assertEqual(state.mode, 'build', 'starts in build')
  startWaveNow(world, state)
  assertEqual(state.wave, 1, 'wave incremented')
  assertEqual(state.mode, 'wave', 'now in wave mode')
})

test('clearing wave returns to build phase with bonus', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 222)
  state.wave = 1
  spawnWave(world, state)
  // Kill all enemies
  for (const [id] of world.entities) {
    if (world.team[id] === TEAM_ENEMY) world.removeEntityById(id)
  }
  const goldBefore = world.gold[TEAM_PLAYER]
  const events = updateTowerDefense(world, state)
  assertEqual(state.mode, 'build', 'back to build phase')
  assert(events.some(e => e.startsWith('wave_cleared')), 'wave_cleared event')
  assert(world.gold[TEAM_PLAYER] > goldBefore, 'clear bonus awarded')
})

test('victory after final wave', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 333)
  state.wave = TD_MAX_WAVES
  spawnWave(world, state)
  for (const [id] of world.entities) {
    if (world.team[id] === TEAM_ENEMY) world.removeEntityById(id)
  }
  const events = updateTowerDefense(world, state)
  assertEqual(state.mode, 'victory', 'victory mode')
  assert(events.includes('victory'), 'victory event')
})

test('defeat when hall destroyed', () => {
  const world = makeBareWorld()
  const state = setupTowerDefense(world, 444)
  state.wave = 1
  spawnWave(world, state)
  // Destroy the hall
  for (const [id] of world.entities) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER) {
      world.removeEntityById(id)
      break
    }
  }
  const events = updateTowerDefense(world, state)
  assertEqual(state.mode, 'defeat', 'defeat mode')
  assert(events.includes('defeat'), 'defeat event')
})
