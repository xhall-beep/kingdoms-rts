/**
 * Bell-duty exemption, completed across every AI worker pick
 * (town-hall note §9). The scout-party fix (ai-scout-party-bellduty)
 * closed dispatchScoutParty; its census found three more picks of the
 * same trip-killer class still unexempted in opponent.ts:
 *
 *   1. scout()'s new-scout pick — a filter feeding an idle find, an
 *      unladen find, and a raw [0] fallback; any branch could send a
 *      muster traveler or an armed pikeman across the map as the scout.
 *   2. expandBase()'s expansion-hall builder pick — the IDLE find
 *      reaches an armed pikeman, the unladen fallback both trip states.
 *   3. build()'s builder pick (via expand()) — the identical find pair,
 *      firing from the opening onward whenever a structure is wanted.
 *
 * resumeStalledBuilds' own comment documents why the exemption exists
 * for exactly these find shapes. Each path is pinned here in the same
 * staging style as the scout-party pins: bell duty staged directly
 * (state + militiaUntil — all isBellDuty reads), the pool's head
 * arranged as the pick's pre-fix preference (an armed pikeman standing
 * STATE_IDLE first, then empty-handed MUSTER/DISARM travelers), no
 * world steps between staging and the think, so the AI reads exactly
 * the staged footprint. Each pin asserts the pick lands on the first
 * eligible worker — and, in the all-bell-duty variant, that the path
 * keeps its existing fallback semantics (no pick at all) instead of
 * seizing a bell-duty peasant.
 */
import {
  World,
  KIND_BARRACKS,
  KIND_HALL,
  KIND_WORKER,
  STATE_BUILD,
  STATE_DISARM,
  STATE_IDLE,
  STATE_MOVE,
  STATE_MUSTER,
  TEAM_ENEMY,
} from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'

const MIRROR = { x: -40, z: -40 } // Enemy hall is at (40, 40); its mirror is the first scout target.

/** Enemy workers in entity-id order — the candidate pool of every pick. */
function enemyWorkers(world: World): number[] {
  const ids: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_ENEMY) ids.push(id)
  }
  return ids.sort((a, b) => a - b)
}

/** A world whose enemy side fields 8 workers (4 seeded + 4 spawned). */
function worldWithPool(): { world: World; pool: number[] } {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  const pool = enemyWorkers(world)
  assertEqual(pool.length, 8, 'eight enemy workers form the candidate pool')
  return { world, pool }
}

/**
 * Stage bell duty on `ids`: the head an armed pikeman standing idle at
 * the stand, the rest alternating MUSTER/DISARM travelers, all
 * empty-handed — the exact heads of every pick's preference order
 * (idle first, then unladen).
 */
function stageBellDuty(world: World, ids: number[]): void {
  const [pikeman, ...rest] = ids
  world.militiaUntil[pikeman] = world.matchTime + 100
  world.state[pikeman] = STATE_IDLE
  world.carryAmount[pikeman] = 0
  rest.forEach((id, i) => {
    world.state[id] = i % 2 === 0 ? STATE_MUSTER : STATE_DISARM
    world.carryAmount[id] = 0
  })
  for (const id of ids) assert(world.isBellDuty(id), `worker ${id} reads as bell duty once staged`)
}

/** Enemy workers moving with a target within `tol` of (x, z). */
function targeting(world: World, x: number, z: number, tol: number): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_WORKER || world.team[id] !== TEAM_ENEMY) continue
    if (world.state[id] !== STATE_MOVE) continue
    const dx = world.targetX[id] - x
    const dz = world.targetZ[id] - z
    if (dx * dx + dz * dz <= tol * tol) found.push(id)
  }
  return found
}

/** The worker ordered to build `siteId`, if any. */
function builderOf(world: World, siteId: number): number | undefined {
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_WORKER || world.team[id] !== TEAM_ENEMY) continue
    if (world.state[id] === STATE_BUILD && world.targetId[id] === siteId) return id
  }
  return undefined
}

/** Any enemy worker currently in STATE_BUILD. */
function anyBuilder(world: World): boolean {
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_WORKER || world.team[id] !== TEAM_ENEMY) continue
    if (world.state[id] === STATE_BUILD) return true
  }
  return false
}

/** The enemy's second hall (any hall not at the seeded (40, 40)), if started. */
function secondHallId(world: World): number | undefined {
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_HALL || world.team[id] !== TEAM_ENEMY) continue
    if (Math.abs(world.positionX[id] - 40) > 1 || Math.abs(world.positionZ[id] - 40) > 1) return id
  }
  return undefined
}

/** The enemy's first structure of `kind`, if any. */
function structureOf(world: World, kind: number): number | undefined {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind && world.team[id] === TEAM_ENEMY) return id
  }
  return undefined
}

suite('ai-bellduty-picks: scout pick skips bell duty')

test('the new scout is the first eligible worker — never the pikeman or a traveler', () => {
  const { world, pool } = worldWithPool()
  stageBellDuty(world, pool.slice(0, 3)) // pikeman, MUSTER, DISARM
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0) // First think: the new-scout pick fires.
  const scout = targeting(world, MIRROR.x, MIRROR.z, 1)
  assertEqual(scout.length, 1, 'exactly one scout is on the road')
  assertEqual(scout[0], pool[3], `the scout is the first eligible worker, got ${scout[0]}`)
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
  assertEqual(world.state[pool[2]], STATE_DISARM, 'the disarm traveler is still on his trip')
})

test('only bell-duty candidates: no scout is picked, the pick retries clean next think', () => {
  const { world, pool } = worldWithPool()
  stageBellDuty(world, pool) // The whole pool is on bell duty.
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  assertEqual(targeting(world, MIRROR.x, MIRROR.z, 1).length, 0, 'no worker walks the scout route')
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
  ai.update(world, 1.0) // The existing fallback retries next think — still nobody eligible.
  assertEqual(targeting(world, MIRROR.x, MIRROR.z, 1).length, 0, 'the retry also picks nobody')
})

suite('ai-bellduty-picks: expansion builder pick skips bell duty')

/** The ai-expansion gate rig: opening complete, army fielded, gold banked. */
function expansionRig(): { world: World; pool: number[] } {
  const { world, pool } = worldWithPool()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  world.spawnBuilding('archery', TEAM_ENEMY, 52, 40, true)
  world.spawnBuilding('smithy', TEAM_ENEMY, 40, 52, true)
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 30 + (i % 3) * 2, 30 + Math.floor(i / 3) * 4)
  }
  world.spawnUnit('ranged', TEAM_ENEMY, 36, 30)
  return { world, pool }
}

test('the expansion hall is built by the first eligible worker', () => {
  const { world, pool } = expansionRig()
  stageBellDuty(world, pool.slice(0, 3))
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200) // gameTime past the expander's 180s expansion gate.
  const hallId = secondHallId(world)
  assert(hallId !== undefined, 'a second hall is started')
  assertEqual(
    builderOf(world, hallId!),
    pool[3],
    'the hall builder is the first eligible worker',
  )
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})

test('only bell-duty candidates: no expansion hall is started', () => {
  const { world, pool } = expansionRig()
  stageBellDuty(world, pool)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 200)
  assertEqual(secondHallId(world), undefined, 'no hall without an eligible builder')
  assert(!anyBuilder(world), 'no bell-duty worker is ordered to build anything')
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})

suite('ai-bellduty-picks: build pick skips bell duty')

/**
 * Build rig: the player hall is revealed, so scout() answers through
 * its found branch and no scout pick consumes a worker first (the
 * dispatch pins' trick); gameTime stays under the expansion gate, so
 * expand()'s barracks want is the only build pick in the think.
 */
function buildRig(): { world: World; pool: number[] } {
  const { world, pool } = worldWithPool()
  world.gold[TEAM_ENEMY] = 600
  world.wood[TEAM_ENEMY] = 300
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40)
  return { world, pool }
}

test('the barracks is built by the first eligible worker', () => {
  const { world, pool } = buildRig()
  stageBellDuty(world, pool.slice(0, 3))
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  const barracksId = structureOf(world, KIND_BARRACKS)
  assert(barracksId !== undefined, 'a barracks is started')
  assertEqual(
    builderOf(world, barracksId!),
    pool[3],
    'the barracks builder is the first eligible worker',
  )
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})

test('only bell-duty candidates: the site is placed but no bell-duty worker is ordered to it', () => {
  const { world, pool } = buildRig()
  stageBellDuty(world, pool)
  const ai = new OpponentAI(TEAM_ENEMY)
  ai.update(world, 1.0)
  // build()'s existing fallback semantics: placement is
  // builder-independent in direct mode, so the husk stands — the pin
  // is that nobody on bell duty is ordered onto it (and
  // resumeStalledBuilds, already exempt, leaves it unbuilt this think).
  assert(structureOf(world, KIND_BARRACKS) !== undefined, 'the barracks site is still placed')
  assert(!anyBuilder(world), 'no bell-duty worker is ordered to build')
  assertEqual(world.state[pool[0]], STATE_IDLE, 'the pikeman was never ordered off his stand')
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})
