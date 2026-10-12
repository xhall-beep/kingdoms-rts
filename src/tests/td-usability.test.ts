/**
 * TD usability regression tests — Guard Tower buildable, tick-based timing,
 * no instant victory, full wave cycle.
 */
import { World, TEAM_PLAYER } from '../core/World.ts'
import { PLAYER_BUILDABLE, placeStructure } from '../world/construction.ts'
import {
setupTowerDefense, updateTowerDefense, TD_BUILD_PHASE_TICKS,
} from '../modes/tower-defense.ts'
import { test, assert, assertEqual } from './harness.ts'

test('Guard Tower is player-buildable', () => {
  assert((PLAYER_BUILDABLE as string[]).includes('tower'), 'tower in PLAYER_BUILDABLE')
})

test('can place a Guard Tower with starting TD resources', () => {
  const world = new World()
  setupTowerDefense(world, 12345)
  const before = world.gold[TEAM_PLAYER]
  const res = placeStructure(world, TEAM_PLAYER, 'tower', 10, 10)
  assert(res.ok, 'tower placement succeeds')
  assert(world.gold[TEAM_PLAYER] < before, 'gold deducted')
})

test('wave cycle runs on ticks: build -> wave -> cleared -> build', () => {
  const world = new World()
  const state = setupTowerDefense(world, 999)
  assertEqual(state.mode, 'build', 'starts in build')
  let sawWaveStart = false
  for (let i = 0; i < TD_BUILD_PHASE_TICKS; i++) {
    const events = updateTowerDefense(world, state)
    if (state.mode === 'wave') {
      assert(events.includes('wave_start:1'), 'wave_start:1 event')
      sawWaveStart = true
      break
    }
  }
  assert(sawWaveStart, 'wave 1 started after build ticks')
  assertEqual(state.wave, 1, 'wave 1')
  assert(state.enemiesRemaining > 0, 'enemies spawned')
  const goldBefore = world.gold[TEAM_PLAYER]
  const dead: number[] = []
  for (const [id] of world.entities) {
    if (world.team[id] === 1) dead.push(id)
  }
  for (const id of dead) world.removeEntityById(id)
  const events = updateTowerDefense(world, state)
  assert(events.includes('wave_cleared:1'), 'wave_cleared:1 event')
  assertEqual(state.mode, 'build', 'starts in build')
  assert(world.gold[TEAM_PLAYER] > goldBefore, 'clear bonus paid')
})

test('no instant victory with zero enemies', () => {
  const world = new World()
  const state = setupTowerDefense(world, 42)
  for (let i = 0; i < 120; i++) updateTowerDefense(world, state)
  assertEqual(state.mode, 'build', 'starts in build')
  assertEqual(world.winner, -1, 'no winner set')
})
