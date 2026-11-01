/**
 * Basics slice 5 — "Soldiers muster home" (Montz's "Improve basics",
 * 2026-11-01; basics audit F7).
 *
 * What is pinned here:
 *  - The audit's first fight: a Barracks' old centre-ward default rally
 *    parked fresh Footmen toward the map centre, where the first enemy
 *    wave met and killed them before it ever reached the base. A
 *    combat-training building now defaults its rally AWAY from the
 *    centre (toward the owning base's corner), so fresh soldiers gather
 *    at home until the player sends them out.
 *  - The hall keeps its centre-ward rally on purpose: the gold sits
 *    centre-ward of the hall, and a fresh worker walks to the rally
 *    before auto-gathering, so flipping the hall would walk workers
 *    away from their work.
 *  - Both directions stay sign-based, so the mirror symmetry the old
 *    centre-ward default protected (no fixed offset favoring one team)
 *    still holds: the two teams' rallies are exact mirrors.
 *  - The default is only a default: an explicit setRally still wins,
 *    and a trained Footman actually walks to the outward rally.
 */
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import {
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_HALL,
  KIND_MELEE,
  World,
} from '../core/World.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { enqueueTrain, setRally } from '../systems/production.ts'

suite('basics slice 5: combat rally defaults home')

test('barracks rally points away from the centre', () => {
  const world = makeWorld()
  // The audit's own example spot: a player Barracks south-west of home.
  const b = world.spawnBuilding('barracks', TEAM_PLAYER, -35, -48, true)
  // Barracks radius 3.9: rally sits radius + 4 = 7.9 out, on the home side.
  assertClose(world.rallyX[b.id], -42.9, 0.01, 'rally X is home-side')
  assertClose(world.rallyZ[b.id], -55.9, 0.01, 'rally Z is home-side')
  assert(world.rallyX[b.id] < -35, 'rally is further from centre in X')
  assert(world.rallyZ[b.id] < -48, 'rally is further from centre in Z')
})

test('opposing barracks rallies are exact mirrors', () => {
  const world = makeWorld()
  const p = world.spawnBuilding('barracks', TEAM_PLAYER, -35, -48, true)
  const e = world.spawnBuilding('barracks', TEAM_ENEMY, 35, 48, true)
  assertClose(world.rallyX[e.id], -world.rallyX[p.id], 0.01, 'mirror X')
  assertClose(world.rallyZ[e.id], -world.rallyZ[p.id], 0.01, 'mirror Z')
})

test('hall rally stays centre-ward (workers walk to work)', () => {
  const world = makeWorld()
  const halls: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_HALL) halls.push(id)
  }
  assert(halls.length > 0, 'scenario hall exists')
  const hall = halls[0]
  // Hall at (-40, -40), radius 5.2: centre-ward rally is (-30.8, -30.8).
  assertClose(world.rallyX[hall], -30.8, 0.01, 'hall rally X unchanged')
  assertClose(world.rallyZ[hall], -30.8, 0.01, 'hall rally Z unchanged')
})

test('a trained footman walks to the outward rally', () => {
  const world = makeWorld()
  const b = world.spawnBuilding('barracks', TEAM_PLAYER, -35, -48, true)
  assert(enqueueTrain(world, b.id, 'melee'), 'melee queued')
  stepWorld(world, 60 * 10) // melee trains in 8s; 10s clears it
  let footman = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_MELEE) {
      footman = id
    }
  }
  assert(footman >= 0, 'footman trained')
  assertClose(world.targetX[footman], world.rallyX[b.id], 0.01, 'footman target X is the rally')
  assertClose(world.targetZ[footman], world.rallyZ[b.id], 0.01, 'footman target Z is the rally')
  assert(world.targetX[footman] < -35, 'footman heads home, not to centre')
})

test('explicit setRally still overrides the default', () => {
  const world = makeWorld()
  const b = world.spawnBuilding('barracks', TEAM_PLAYER, -35, -48, true)
  setRally(world, b.id, -20, -20)
  assertEqual(world.rallyX[b.id], -20, 'explicit rally X wins')
  assertEqual(world.rallyZ[b.id], -20, 'explicit rally Z wins')
})

test('default rally is deterministic across fresh worlds', () => {
  const a = new World()
  const b = new World()
  const ba = a.spawnBuilding('barracks', TEAM_ENEMY, 30, 44, true)
  const bb = b.spawnBuilding('barracks', TEAM_ENEMY, 30, 44, true)
  assertEqual(a.rallyX[ba.id], b.rallyX[bb.id], 'rally X deterministic')
  assertEqual(a.rallyZ[ba.id], b.rallyZ[bb.id], 'rally Z deterministic')
})
