/**
 * Season Wheel tests (v2.0 spec): at the Second Bell (6:00) the season
 * turns to winter and snow slows every unit's movement by 25%. The turn
 * is a pure function of the bell state, so it is deterministic under
 * lockstep, and the season is part of the hashed sim state.
 */
import { World, TEAM_PLAYER } from '../core/World.ts'
import { BellSystemImpl, BELL_TIMES, bellRung } from '../systems/bells.ts'
import {
  SeasonSystemImpl,
  SEASON_GROWING,
  SEASON_WINTER,
  WINTER_SPEED_MULT,
  seasonSpeedMult,
} from '../systems/season.ts'
import { MovementSystemImpl, orderMove } from '../systems/movement.ts'
import { hashWorldState } from '../net/hash.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('season: the Second Bell turn')

function makeSeasonWorld(withSeason = true): World {
  const world = new World()
  world.registerSystem(new BellSystemImpl())
  if (withSeason) world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

test('season starts in the growing season', () => {
  const world = makeSeasonWorld()
  assertEqual(world.season, SEASON_GROWING, 'season starts growing')
  assertEqual(seasonSpeedMult(world), 1, 'no slowdown before the turn')
})

test('season does not turn at the First Bell', () => {
  const world = makeSeasonWorld()
  stepWorld(world, Math.floor(BELL_TIMES[0] / STEP) + 30)
  assert(bellRung(world, 0), 'sanity: first bell has rung')
  assertEqual(world.season, SEASON_GROWING, 'still growing after the First Bell')
})

test('season turns to winter at the Second Bell', () => {
  const world = makeSeasonWorld()
  stepWorld(world, Math.floor(BELL_TIMES[1] / STEP) - 30)
  assertEqual(world.season, SEASON_GROWING, 'growing just before 6:00')
  stepWorld(world, 60)
  assert(bellRung(world, 1), 'sanity: second bell has rung')
  assertEqual(world.season, SEASON_WINTER, 'winter after the Second Bell')
  assertEqual(seasonSpeedMult(world), WINTER_SPEED_MULT, 'snow slowdown active')
})

test('snow slows movement by the winter multiplier', () => {
  const march = (season: number): number => {
    const world = new World()
    world.registerSystem(new MovementSystemImpl())
    world.season = season
    const unit = world.spawnUnit('melee', TEAM_PLAYER, -20, 0)
    orderMove(world, unit.id, 500, 0)
    stepWorld(world, 120)
    return world.positionX[unit.id] - -20
  }
  const autumn = march(SEASON_GROWING)
  const winter = march(SEASON_WINTER)
  assert(autumn > 0, 'sanity: unit marched in the growing season')
  const ratio = winter / autumn
  assert(
    Math.abs(ratio - WINTER_SPEED_MULT) < 0.02,
    `winter march is ${ratio.toFixed(3)}x the autumn march (want ~${WINTER_SPEED_MULT})`,
  )
})

test('the turn slows a march already under way', () => {
  // Control: bells + movement but NO season system — winter never comes.
  const control = makeSeasonWorld(false)
  const turned = makeSeasonWorld(true)
  const marchPastTheBell = (world: World): number => {
    const unit = world.spawnUnit('melee', TEAM_PLAYER, -20, 0)
    stepWorld(world, Math.floor(350 / STEP)) // march out just before 6:00
    orderMove(world, unit.id, 500, 0)
    stepWorld(world, 1200) // 20 s across the Second Bell
    return world.positionX[unit.id]
  }
  const controlX = marchPastTheBell(control)
  const turnedX = marchPastTheBell(turned)
  assertEqual(turned.season, SEASON_WINTER, 'sanity: season turned')
  assertEqual(control.season, SEASON_GROWING, 'sanity: control never turned')
  assert(turnedX < controlX, 'winter march covers less ground than the control')
})

test('season is part of the hashed sim state', () => {
  const a = new World()
  const b = new World()
  assertEqual(hashWorldState(a), hashWorldState(b), 'identical worlds hash identically')
  b.season = SEASON_WINTER
  assert(hashWorldState(a) !== hashWorldState(b), 'winter world hashes differently')
})

test('determinism holds across the turn', () => {
  const run = (): World => {
    const world = makeSeasonWorld()
    const unit = world.spawnUnit('melee', TEAM_PLAYER, -20, 0)
    world.spawnUnit('melee', TEAM_PLAYER, -24, 4)
    orderMove(world, unit.id, 500, 0)
    stepWorld(world, Math.floor(BELL_TIMES[1] / STEP) + 600)
    return world
  }
  const a = run()
  const b = run()
  assertEqual(a.season, SEASON_WINTER, 'sanity: season turned in run A')
  assertEqual(hashWorldState(a), hashWorldState(b), 'same seed, same hash across the flip')
})

test('season survives save/load round-trip', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeSeasonWorld()
  stepWorld(world, Math.floor(BELL_TIMES[1] / STEP) + 30)
  assertEqual(world.season, SEASON_WINTER, 'sanity: winter before save')
  const save = serializeWorld(world, 0, [])
  const restored = makeSeasonWorld()
  deserializeWorld(restored, save)
  assertEqual(restored.season, SEASON_WINTER, 'winter restored after load')
})
