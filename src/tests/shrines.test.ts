/**
 * Shrine & Victory Points tests (v2.0 spec, section 4: anti-stall).
 *
 * A central shrine is capturable: sole military presence within the radius
 * takes it. Each held shrine drains 5 enemy VP/sec. At 0 VP the team loses.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_SHRINE } from '../core/World.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('shrines: victory points anti-stall')

function makeWorld(): World {
  const world = new World()
  world.registerSystem(new ShrineSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.spawnShrine(0, 0)
  // Both teams need something alive or the victory system ends the match
  // before the shrine logic ever ticks.
  world.spawnBuilding('hall', TEAM_PLAYER, -40, -40, true)
  world.spawnBuilding('hall', TEAM_ENEMY, 40, 40, true)
  return world
}

function shrineOf(world: World): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) return id
  }
  throw new Error('no shrine')
}

test('sole presence captures the shrine', () => {
  const world = makeWorld()
  const shrine = shrineOf(world)
  assertEqual(world.shrineHeld[shrine], -1, 'starts neutral')
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  stepWorld(world, 70) // >1s for the capture check
  assertEqual(world.shrineHeld[shrine], TEAM_PLAYER, 'player holds the shrine')
})

test('contested shrine keeps its holder', () => {
  const world = makeWorld()
  const shrine = shrineOf(world)
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  stepWorld(world, 70)
  assertEqual(world.shrineHeld[shrine], TEAM_PLAYER, 'player takes it')
  world.spawnUnit('melee', TEAM_ENEMY, -2, 0) // contest
  stepWorld(world, 70)
  assertEqual(world.shrineHeld[shrine], TEAM_PLAYER, 'contested: holder keeps it')
})

test('holding the shrine drains enemy VP', () => {
  const world = makeWorld()
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  const before = world.victoryPoints[TEAM_ENEMY]
  stepWorld(world, 70)
  const after = world.victoryPoints[TEAM_ENEMY]
  assert(after < before, `VP drained: ${before} -> ${after}`)
  assertEqual(before - after, 5, '5 VP per second per shrine')
})

test('zero VP loses the game', () => {
  const world = makeWorld()
  world.victoryPoints[TEAM_ENEMY] = 3
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  stepWorld(world, 70)
  assertEqual(world.winner, TEAM_PLAYER, 'enemy stalled out on VP')
})

test('shrine state survives save/load', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  stepWorld(world, 70)
  const shrine = shrineOf(world)
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assertEqual(restored.shrineHeld[shrine], TEAM_PLAYER, 'holder restored')
  assertEqual(
    restored.victoryPoints[TEAM_ENEMY],
    world.victoryPoints[TEAM_ENEMY],
    'VP restored',
  )
})

test('scenario seeds the central shrine', async () => {
  const { seedScenario } = await import('../scenario.ts')
  const world = new World()
  seedScenario(world)
  let count = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) count += 1
  }
  assertEqual(count, 1, 'one central shrine per match')
})
