/**
 * AI expansion tests — the expander's second hall must land on its own gold.
 *
 * Two defects, both probe-proven before the fix:
 * (1) expandBase() picked the mine FARTHEST from its own halls, which on
 * the shipped map is the enemy's gold field: with the gold gate
 * satisfied, one think started a hall at (-18,-22), 28 from the enemy
 * hall and 85 from its own — a builder walking into the enemy base.
 * (2) The 400g snapshot gate never reserved: trainSoldiers ate the stake
 * every think, so in a 10-minute expander mirror the bank peaked at
 * 351g and no second hall was ever attempted.
 * Headless and deterministic.
 */
import { World, KIND_HALL, TEAM_ENEMY, TEAM_PLAYER } from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { seedScenario } from '../scenario.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, STEP } from './setup.ts'

suite('ai-expansion: second hall on own gold')

function teamHalls(world: World, team: number): { x: number; z: number; done: boolean }[] {
  const found: { x: number; z: number; done: boolean }[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_HALL || world.team[id] !== team) continue
    found.push({
      x: world.positionX[id],
      z: world.positionZ[id],
      done: world.buildProgress[id] >= world.buildTotal[id],
    })
  }
  return found
}

/** Enemy main hall is the seeded one at (40, 40); player hall at (-40, -40). */
function secondHall(world: World): { x: number; z: number; done: boolean } | undefined {
  return teamHalls(world, TEAM_ENEMY).find(
    (h) => Math.abs(h.x - 40) > 1 || Math.abs(h.z - 40) > 1,
  )
}

test('with the gold gate satisfied, one think starts the hall on own-side gold', () => {
  const world = makeWorld()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  // The expansion gate needs the opening complete: both chain tech
  // buildings standing finished (expander order: archery, smithy) —
  // and a complete army fielded (expander threshold is 6 soldiers,
  // including at least one ranged unit).
  world.spawnBuilding('archery', TEAM_ENEMY, 52, 40, true)
  world.spawnBuilding('smithy', TEAM_ENEMY, 40, 52, true)
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 30 + (i % 3) * 2, 30 + Math.floor(i / 3) * 4)
  }
  world.spawnUnit('ranged', TEAM_ENEMY, 36, 30)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200) // gameTime past the expander's 180s expansionAtSec
  const hall = secondHall(world)
  assert(hall !== undefined, 'a second hall is started')
  const distOwn = Math.hypot(hall!.x - 40, hall!.z - 40)
  const distEnemy = Math.hypot(hall!.x - -40, hall!.z - -40)
  assert(
    distOwn < distEnemy,
    `second hall must sit closer to our hall than the enemy's: own=${distOwn.toFixed(1)} enemy=${distEnemy.toFixed(1)} at (${hall!.x.toFixed(1)},${hall!.z.toFixed(1)})`,
  )
  assert(distOwn < 60, `second hall must be own-side, got ${distOwn.toFixed(1)} from our hall`)
})

test('no expansion while the opening is still in progress', () => {
  const world = makeWorld()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  // No tech buildings standing: the 350g hall reserve must not starve
  // the opening army, so no hall is started even with gold banked.
  // A complete army is staged (6 melee + 1 ranged) so only the chain
  // gate blocks.
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 30 + (i % 3) * 2, 30 + Math.floor(i / 3) * 4)
  }
  world.spawnUnit('ranged', TEAM_ENEMY, 36, 30)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200)
  assertEqual(secondHall(world), undefined, 'opening incomplete: no hall')
})

test('no expansion before the attack army exists, even with the chain done', () => {
  const world = makeWorld()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  world.spawnBuilding('archery', TEAM_ENEMY, 52, 40, true)
  world.spawnBuilding('smithy', TEAM_ENEMY, 40, 52, true)
  // Only 3 soldiers: below the expander's attack threshold of 6, so
  // the hall reserve must not starve the army still being built. One
  // ranged unit is staged so only the army-count leg blocks.
  for (let i = 0; i < 3; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 30 + i * 2, 30)
  }
  world.spawnUnit('ranged', TEAM_ENEMY, 36, 30)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200)
  assertEqual(secondHall(world), undefined, 'army below threshold: no hall')
})

test('no expansion before the first archer is fielded', () => {
  const world = makeWorld()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  world.spawnBuilding('archery', TEAM_ENEMY, 52, 40, true)
  world.spawnBuilding('smithy', TEAM_ENEMY, 40, 52, true)
  // A full melee army at threshold, but no ranged unit yet: the hall
  // reserve must not block the first archer the tech-chain probe
  // watches for.
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 30 + (i % 3) * 2, 30 + Math.floor(i / 3) * 4)
  }
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200)
  assertEqual(secondHall(world), undefined, 'no ranged unit yet: no hall')
})

test('the aggressor never starts a second hall, even with gold banked', () => {
  const world = makeWorld()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  ai.update(world, 200)
  assertEqual(secondHall(world), undefined, 'aggressor expansionAtSec is Infinity: no hall')
})

test('the expander completes a second hall inside a 10-minute match', () => {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new MovementSystemImpl())
  world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'expander'))
  world.registerSystem(new OpponentAI(TEAM_ENEMY, 'normal', 'expander'))
  seedScenario(world, 'human', 'orc')

  const maxSteps = 60 * 60 * 10 // 10 minutes of sim
  let steps = 0
  let completedAt = -1
  while (world.winner === -1 && steps < maxSteps) {
    world.update(STEP)
    steps += 1
    if (completedAt === -1) {
      const done =
        teamHalls(world, TEAM_PLAYER).filter((h) => h.done).length >= 2 ||
        teamHalls(world, TEAM_ENEMY).filter((h) => h.done).length >= 2
      if (done) completedAt = steps
    }
  }
  assert(
    completedAt !== -1,
    `no second hall completed in ${steps / 3600} sim-minutes (winner=${world.winner})`,
  )
})
