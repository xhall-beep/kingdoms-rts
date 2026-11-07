/**
 * Scout-party bell-duty exemption (shipped-bug fix, found by the
 * separation QA trace): dispatchScoutParty built its candidate list
 * without the bell-duty exemption every sibling worker pick already
 * applies (evacuateWorkers, assignWorkers, resumeStalledBuilds —
 * town-hall note §9). A peasant traveling to arm (STATE_MUSTER),
 * serving (isMilitia), or returning to hand the pike in
 * (STATE_DISARM) could be picked into a scouting party and yanked off
 * the bell machine's trip — the QA trace caught a MUSTER traveler
 * flipped ATTACK→MOVE for a tick by exactly this pick.
 *
 * Staging mirrors ai-scout-kill's "killed after finding the enemy"
 * rig (reveal the player hall so scout() answers through the found
 * branch and no replacement scout is picked first — the replacement
 * pick is a separate consumer, not this pin). Bell duty is staged
 * directly (state + militiaUntil) after the scout is on the road, with
 * no world steps between staging and the kill think, so the AI reads
 * exactly the staged footprint — state and militiaUntil are all
 * isBellDuty reads.
 *
 * Role layout (non-scout enemy workers, entity order): an armed
 * pikeman standing STATE_IDLE at the stand (the pick's first
 * preference), then MUSTER/DISARM peasants with empty hands (the
 * second preference). Pre-fix, the party is [pikeman, first traveler]
 * — both bell-duty. Post-fix it must be the eligible workers only, or
 * nobody when no eligible worker exists.
 */
import {
  World,
  HARVEST_GOLD,
  KIND_WORKER,
  STATE_DISARM,
  STATE_IDLE,
  STATE_MOVE,
  STATE_MUSTER,
  TEAM_ENEMY,
} from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

suite('ai-scout-party-bellduty: party picks skip bell duty')

const MIRROR = { x: -40, z: -40 } // Enemy hall is at (40, 40); its mirror is the first scout target.

function think(ai: OpponentAI, world: World, dt: number): void {
  ai.update(world, dt)
}

/** Advance the world `seconds` sim-seconds, thinking once per second (as in ai-scout-kill). */
function advance(ai: OpponentAI, world: World, seconds: number): void {
  for (let s = 0; s < seconds; s += 1) {
    stepWorld(world, 60)
    think(ai, world, 1.0)
  }
}

/** Enemy units of `kind` moving with a target within `tol` of (x, z). */
function targeting(world: World, kind: number, x: number, z: number, tol: number): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind || world.team[id] !== TEAM_ENEMY) continue
    if (world.state[id] !== STATE_MOVE) continue
    const dx = world.targetX[id] - x
    const dz = world.targetZ[id] - z
    if (dx * dx + dz * dz <= tol * tol) found.push(id)
  }
  return found
}

/** The live scout: the moving enemy worker headed for the mirror target. */
function liveScout(world: World): number | undefined {
  return targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1)[0]
}

/** Enemy workers in entity-id order. */
function enemyWorkers(world: World): number[] {
  const ids: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_ENEMY) ids.push(id)
  }
  return ids.sort((a, b) => a - b)
}

interface Rig {
  world: World
  ai: OpponentAI
  scout: number
  deathX: number
  deathZ: number
  /** Non-scout enemy workers in entity order — the candidate pool. */
  pool: number[]
}

/**
 * Base rig: a mid-early economy (8 workers), one melee staged (the
 * after-discovery party-gate shape), the scout 5 sim-seconds down the
 * road, and the player hall revealed so the kill answers through the
 * found branch — party only, no replacement pick.
 */
function rig(): Rig {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0)
  advance(ai, world, 5)
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40)
  const pool = enemyWorkers(world).filter((id) => id !== scout)
  assertEqual(pool.length, 7, 'seven non-scout workers form the candidate pool')
  return { world, ai, scout: scout!, deathX, deathZ, pool }
}

/**
 * Stage the bell-duty head of the pool: an armed pikeman standing
 * idle at the stand, then MUSTER/DISARM peasants, all empty-handed —
 * the exact heads of the party pick's preference order (idle first,
 * then unladen). Returns the staged ids.
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

test('party forms from eligible workers only — bell-duty peasants are never picked', () => {
  const { world, ai, scout, deathX, deathZ, pool } = rig()
  const bellDuty = pool.slice(0, 5)
  const eligible = pool.slice(5)
  stageBellDuty(world, bellDuty)
  // The two eligible workers are mid-task and laden, so the pick's
  // idle and unladen passes both reach them last — pre-fix, both
  // passes land on bell-duty peasants first.
  for (const id of eligible) {
    world.state[id] = STATE_MOVE
    world.targetX[id] = world.positionX[id]
    world.targetZ[id] = world.positionZ[id]
    world.carryAmount[id] = 3
    world.harvestKind[id] = HARVEST_GOLD
  }
  world.removeEntityById(scout)
  think(ai, world, 1.0) // Death detected: the party answers.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'one kill counted')
  assertEqual(resp.partiesSent, 1, 'the party still forms from the eligible workers')
  assertEqual(resp.delaySec, 30, 'the first-kill delay stands')
  const party = targeting(world, KIND_WORKER, deathX, deathZ, 8).sort((a, b) => a - b)
  assertEqual(
    party.join(','),
    [...eligible].sort((a, b) => a - b).join(','),
    `the party is exactly the two eligible workers, got [${party.join(',')}]`,
  )
  for (const id of bellDuty) {
    assert(!party.includes(id), `bell-duty worker ${id} was not picked into the party`)
  }
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})

test('only bell-duty candidates: no party is staked, the delay still stands', () => {
  const { world, ai, scout, deathX, deathZ, pool } = rig()
  stageBellDuty(world, pool) // The whole pool is on bell duty.
  world.removeEntityById(scout)
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'one kill counted')
  assertEqual(resp.partiesSent, 0, 'no party when every candidate is on bell duty')
  assertEqual(resp.delaySec, 30, 'the delay still stands without the party')
  assertEqual(
    targeting(world, KIND_WORKER, deathX, deathZ, 8).length,
    0,
    'no worker walks to the death area',
  )
  assertEqual(world.state[pool[1]], STATE_MUSTER, 'the muster traveler is still on his trip')
})
