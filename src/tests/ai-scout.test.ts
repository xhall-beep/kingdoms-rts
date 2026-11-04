/**
 * AI scout tests — a scout killed mid-route must be replaced.
 *
 * The scout route is a queue: the AI sends one worker through the
 * mirror position and two flanks, advancing on arrival. The re-scout
 * branch only fires with an empty queue, so a scout that died with
 * unvisited targets stranded the queue and the AI never scouted
 * again for the rest of the 180s scouting window — blind against an
 * enemy it had never found. The fix clears the dead scout's remaining
 * targets, so the next think dispatches a replacement.
 * Headless and deterministic.
 */
import { World, KIND_WORKER, STATE_IDLE, STATE_MOVE, TEAM_ENEMY } from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'

suite('ai-scout: replacement after death')

function enemyWorkers(world: World): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_ENEMY) found.push(id)
  }
  return found
}

function movingWorkers(world: World): number[] {
  return enemyWorkers(world).filter((id) => world.state[id] === STATE_MOVE)
}

test('first think dispatches exactly one scout', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  const moving = movingWorkers(world)
  assertEqual(moving.length, 1, `one worker ordered out as scout, got ${moving.length}`)
})

test('a scout killed mid-route is replaced on the next think', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  const scout = movingWorkers(world)[0]
  assert(scout !== undefined, 'a scout was dispatched')
  // Killed mid-route, before reaching its first target: unvisited
  // targets remain in the queue — the exact strand the fix closes.
  world.removeEntityById(scout)
  ai.update(world, 1.0)
  const replacement = movingWorkers(world)
  assertEqual(replacement.length, 1, `a replacement scout is dispatched, got ${replacement.length}`)
  assert(
    world.entities.has(replacement[0]),
    'the replacement is a living worker, not the dead scout',
  )
})

test('a scout that arrives advances to its next target, not a new scout', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  const scout = movingWorkers(world)[0]
  assert(scout !== undefined, 'a scout was dispatched')
  // Simulate arrival at the first target: idle with targets remaining.
  world.state[scout] = STATE_IDLE
  ai.update(world, 1.0)
  assertEqual(movingWorkers(world).length, 1, 'still exactly one scout on the road')
  assertEqual(movingWorkers(world)[0], scout, 'the same scout continues its route')
})
