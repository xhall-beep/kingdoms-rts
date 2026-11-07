/**
 * Militia Bell expiry — clock-arithmetic pins.
 *
 * The levy stamp (militiaUntil) is stored in a Float32Array while
 * matchTime is a float64 accumulated one STEP at a time, so a stamp's
 * stored value can sit a hair above the accumulated clock at its own
 * designed lapse tick. Before the expiry comparison was hardened
 * (MILITIA_EXPIRY_TOLERANCE_SEC), whether a lapse fired on its
 * designed tick or one tick late was decided by that representation
 * error — measured on the unhardened code: a one-tick stamp lapsed
 * late on 4 of 7 accumulation histories, and a full 25 s levy served
 * 1501 ticks instead of the designed 1500 on 6 of 11 histories. A
 * late lapse is not cosmetic: the expiry pass runs before combat,
 * and in the slipped tick combat's target hygiene legitimately
 * clears a re-tasked pikeman's staged target (his build site is his
 * own building, his gather node is a resource — neither is a combat
 * target), so the stand-down then releases him to the economy
 * instead of leaving his work order owning him (the property
 * militia-townhall §a-5/§b-5 names).
 *
 * These tests pin the hardened semantics directly: the lapse lands
 * on its designed tick at EVERY accumulation history, and a full
 * levy serves exactly MILITIA_DURATION_SEC × 60 ticks.
 */
import {
  World,
  TEAM_PLAYER,
  STATE_BUILD,
} from '../core/World.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { STEP } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

/** Same bare-world factory shape as militia-townhall.test.ts (no AI).
 *  No resource nodes are spawned, so pre-ring ticks are inert: an
 *  idle worker with no node in the world simply stays idle, and the
 *  only thing a pre-ring tick changes is the clock's accumulation
 *  history — which is exactly the variable under test. */
function makeBareWorld(): World {
  const world = new World()
  world.factionOfTeam = ['human' as never, 'human' as never]
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new BellSystemImpl())
  world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new WarHornSystemImpl())
  world.registerSystem(new ShrineSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

/** Hall + one worker at (8, 0); advance the clock preTicks ticks,
 *  ring, and step until he arms. Returns the armed world + worker. */
function armedWorld(preTicks: number): { world: World; worker: number } {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
  for (let i = 0; i < preTicks; i += 1) world.update(STEP)
  world.ringMilitiaBell(TEAM_PLAYER)
  let guard = 0
  while (!world.isMilitia(worker) && guard < 900) {
    world.update(STEP)
    guard += 1
  }
  assert(world.isMilitia(worker), 'the worker arms')
  return { world, worker }
}

suite('militia-expiry-clock: the lapse lands on its designed tick')

test('a one-tick levy stamp lapses on the designed tick at every accumulation history', () => {
  for (let preTicks = 0; preTicks <= 6; preTicks += 1) {
    const { world, worker } = armedWorld(preTicks)
    const site = world.spawnBuilding('barracks', TEAM_PLAYER, 20, 20, false).id
    // Re-task him mid-levy to a build order, then stage the lapse one
    // tick out — the §a-5/§b-5 shape in miniature.
    world.state[worker] = STATE_BUILD
    world.targetId[worker] = site
    world.militiaUntil[worker] = world.matchTime + STEP
    world.update(STEP)
    assertEqual(
      world.militiaUntil[worker],
      0,
      `history ${preTicks}: the lapse fired on the designed (first) tick`,
    )
    assertEqual(
      world.state[worker],
      STATE_BUILD,
      `history ${preTicks}: the build order still owns its pikeman through the lapse`,
    )
    assertEqual(
      world.targetId[worker],
      site,
      `history ${preTicks}: the build target survived the lapse tick`,
    )
  }
})

test('a full levy serves exactly 1500 ticks at every accumulation history', () => {
  for (const preTicks of [0, 1, 2, 3, 5, 8]) {
    const { world, worker } = armedWorld(preTicks)
    let serviceTicks = 0
    while (world.isMilitia(worker) && serviceTicks < 2400) {
      world.update(STEP)
      serviceTicks += 1
    }
    assertEqual(
      serviceTicks,
      1500,
      `history ${preTicks}: the levy served exactly the designed 25 s (1500 ticks)`,
    )
  }
})

test('the lapse lands on its designed tick at a long-match clock (3600 s)', () => {
  const { world, worker } = (() => {
    const w = makeBareWorld()
    // Stage a long match's clock directly: the accumulation proceeds
    // from here exactly as it would had the match run an hour.
    w.matchTime = 3600
    w.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
    const id = w.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
    w.ringMilitiaBell(TEAM_PLAYER)
    let guard = 0
    while (!w.isMilitia(id) && guard < 900) {
      w.update(STEP)
      guard += 1
    }
    assert(w.isMilitia(id), 'the worker arms at the long-match clock')
    return { world: w, worker: id }
  })()
  const site = world.spawnBuilding('barracks', TEAM_PLAYER, 20, 20, false).id
  world.state[worker] = STATE_BUILD
  world.targetId[worker] = site
  world.militiaUntil[worker] = world.matchTime + STEP
  world.update(STEP)
  assertEqual(world.militiaUntil[worker], 0, 'the lapse fired on the designed (first) tick')
  assertEqual(world.state[worker], STATE_BUILD, 'the build order still owns its pikeman')
  assertEqual(world.targetId[worker], site, 'the build target survived the lapse tick')
})
