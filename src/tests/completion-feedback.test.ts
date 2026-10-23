/**
 * Completion feedback — building-finished and unit-trained events are
 * visual-only: the sim pushes them into world.completionFlashes, the
 * renderer drains them each frame for the gold-ring pop + completion sfx,
 * and the lockstep hash must never see them. Guards the completion-cue
 * game-feel pass (buildings and trained units no longer finish silently).
 */
import { World, KIND_WORKER, KIND_HALL, STATE_BUILD } from '../core/World.ts'
import { hashWorldState } from '../net/hash.ts'
import { makeWorld, stepWorld, STEP } from './setup.ts'
import { enqueueTrain } from '../systems/production.ts'
import { suite, test, assert } from './harness.ts'

suite('completion-feedback: building and training completion cues')

/** A team-0 worker parked next to an unfinished farm, one tick from done. */
function makeAlmostBuiltFarm(world: World): { worker: number; site: number } {
  world.gold[0] = 1000
  world.wood[0] = 1000
  const site = world.spawnBuilding('farm', 0, -30, -30, false).id
  world.buildProgress[site] = world.buildTotal[site] - STEP / 2
  let worker = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === 0 && world.kind[id] === KIND_WORKER) { worker = id; break }
  }
  assert(worker !== -1, 'need a team-0 worker')
  world.positionX[worker] = world.positionX[site] + 2
  world.positionZ[worker] = world.positionZ[site]
  world.state[worker] = STATE_BUILD
  world.targetId[worker] = site
  world.moving[worker] = 0
  return { worker, site }
}

test('finishing a building pushes a completion flash for its team', () => {
  const world = makeWorld()
  const { site } = makeAlmostBuiltFarm(world)
  world.completionFlashes.length = 0
  stepWorld(world, 10)
  assert(world.buildProgress[site] >= world.buildTotal[site], 'farm should be finished')
  assert(world.completionFlashes.length === 1, 'expected exactly one completion flash')
  const ev = world.completionFlashes[0]
  assert(ev.id === site, 'flash should name the finished building')
  assert(ev.unit === false, 'building completion is not a unit event')
  assert(ev.team === 0, 'flash should record the owning team')
  assert(world.entities.has(ev.id), 'flashed id must be a live entity')
})

test('finishing a unit pushes a unit completion flash for its team', () => {
  const world = makeWorld()
  world.gold[0] = 10000
  world.wood[0] = 10000
  let hall = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === 0 && world.kind[id] === KIND_HALL) { hall = id; break }
  }
  assert(hall !== -1, 'need a team-0 hall')
  const ok = enqueueTrain(world, hall, 'worker')
  assert(ok, 'hall should queue a worker')
  world.trainLeft[hall] = STEP / 2 // finish on the next tick
  const before = world.entities.size
  world.completionFlashes.length = 0
  stepWorld(world, 10)
  assert(world.entities.size === before + 1, 'the worker should have spawned')
  const found = world.completionFlashes.find((e) => e.unit === true)
  assert(found !== undefined, 'expected a unit completion flash')
  const ev = found as { id: number; unit: boolean; team: 0 | 1 }
  assert(ev.team === 0, 'flash should record the owning team')
  assert(world.entities.has(ev.id), 'flashed building id must be a live entity')
})

test('enemy completions are pushed too — the renderer filters by viewer team', () => {
  const world = makeWorld()
  const { site } = makeAlmostBuiltFarm(world)
  // Reassign the farm to the enemy mid-build: the sim must still record it;
  // the renderer's per-team filter (not the sim) decides who cues on it.
  world.team[site] = 1
  world.completionFlashes.length = 0
  stepWorld(world, 10)
  assert(world.completionFlashes.length === 1, 'enemy completion should still be recorded')
  assert(world.completionFlashes[0].team === 1, 'flash should record the enemy team')
})

test('completion flashes never enter the lockstep hash', () => {
  const world = makeWorld()
  const before = hashWorldState(world)
  world.completionFlashes.push({ id: 7, unit: false, team: 0 })
  world.completionFlashes.push({ id: 9, unit: true, team: 1 })
  const after = hashWorldState(world)
  assert(before === after, 'visual-only completion events must not affect the state hash')
})
