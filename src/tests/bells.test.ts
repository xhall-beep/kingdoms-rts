/**
 * Three Bells pacing tests (v2.0 spec, section 4: "Pacing: The Three Bells").
 *
 * The match clock rings at 3:00 / 6:00 / 9:00. The First Bell ends the quiet
 * opening: the AI must not attack before it rings. Ringing is a pure function
 * of matchTime, so it is deterministic under lockstep.
 */
import { World, TEAM_ENEMY, STATE_IDLE } from '../core/World.ts'
import { BellSystemImpl, BELL_TIMES, bellRung } from '../systems/bells.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('bells: three-bell pacing')

function makeWorld(): World {
  const world = new World()
  world.registerSystem(new BellSystemImpl())
  return world
}

test('no bells rung at match start', () => {
  const world = makeWorld()
  assertEqual(world.matchTime, 0, 'matchTime starts at 0')
  assert(!bellRung(world, 0), 'first bell not rung')
  assert(!bellRung(world, 1), 'second bell not rung')
  assert(!bellRung(world, 2), 'third bell not rung')
})

test('first bell rings at 3:00', () => {
  const world = makeWorld()
  stepWorld(world, Math.floor(BELL_TIMES[0] / STEP) - 10)
  assert(!bellRung(world, 0), 'silent just before 3:00')
  stepWorld(world, 20)
  assert(bellRung(world, 0), 'first bell rung at 3:00')
  assert(!bellRung(world, 1), 'second bell still silent')
})

test('all three bells ring in order', () => {
  const world = makeWorld()
  stepWorld(world, Math.floor(BELL_TIMES[2] / STEP) + 10)
  assert(bellRung(world, 0), 'first bell rung')
  assert(bellRung(world, 1), 'second bell rung')
  assert(bellRung(world, 2), 'third bell rung')
})

test('bells survive save/load round-trip', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  stepWorld(world, Math.floor(BELL_TIMES[0] / STEP) + 5)
  assert(bellRung(world, 0), 'sanity: bell rung before save')
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  restored.registerSystem(new BellSystemImpl())
  deserializeWorld(restored, save)
  assert(bellRung(restored, 0), 'first bell still rung after load')
  assert(Math.abs(restored.matchTime - world.matchTime) < 0.01, 'matchTime restored')
})

test('AI does not attack before the First Bell', () => {
  const world = new World()
  world.factionOfTeam = ['human', 'orc']
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  world.registerSystem(new BellSystemImpl())
  // Give the AI a hall and a raiding party well before the bell.
  const hall = world.spawnBuilding('hall', TEAM_ENEMY, 40, 40, true).id
  void hall
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, 38 + i, 38).id)
  }
  world.gold[TEAM_ENEMY] = 1000
  world.wood[TEAM_ENEMY] = 1000
  // Run the AI for 60 sim-seconds (still before the 3:00 bell).
  for (let i = 0; i < 60; i += 1) {
    world.update(1)
    ai.update(world, 1)
  }
  assert(!bellRung(world, 0), 'sanity: bell has not rung')
  const attacked = soldiers.some((id) => world.state[id] !== STATE_IDLE)
  assert(!attacked, 'AI holds its army before the First Bell')
})

test('AI attacks after the First Bell', () => {
  const world = new World()
  world.factionOfTeam = ['human', 'orc']
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  world.registerSystem(new BellSystemImpl())
  const hall = world.spawnBuilding('hall', TEAM_ENEMY, 40, 40, true).id
  void hall
  // Player hall far away so the AI has a target to find.
  world.spawnBuilding('hall', 0, -40, -40, true)
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, 38 + i, 38).id)
  }
  world.gold[TEAM_ENEMY] = 1000
  world.wood[TEAM_ENEMY] = 1000
  // Fast-forward past the bell, then let the AI think.
  stepWorld(world, Math.floor(BELL_TIMES[0] / STEP) + 5)
  assert(bellRung(world, 0), 'sanity: bell has rung')
  for (let i = 0; i < 120; i += 1) {
    world.update(1)
    ai.update(world, 1)
  }
  const attacked = soldiers.some((id) => world.state[id] !== STATE_IDLE)
  assert(attacked, 'AI sends its first probe after the First Bell')
})
