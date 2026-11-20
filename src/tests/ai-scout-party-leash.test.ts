/**
 * Squad leash (2026-11-20 — retune follow-up, QA verdict 2026-11-06):
 * a dispatched scout party/squad is a probe, not a detachment. Once
 * the death area is cleared it comes home to the hall instead of
 * loitering at the spot until the next wave folds it in; and when the
 * death area is held by a force that outnumbers the squad, it comes
 * home at once instead of walking into the kill that ate the scout.
 * The recall must never yank a member off other duty: anyone
 * re-tasked (gathering, folded into a wave, fighting) drops off the
 * leash instead of being recalled.
 *
 * Staging mirrors ai-scout-kill's rigs: the scout is killed with
 * removeEntityById after 5 sim-seconds on the road, and the late
 * squad is reached by fast-forwarding the AI clock past the 180s
 * party window with one big-dt think (the same trick ai-scout-kill's
 * defense test uses) — the scout has not moved between thinks, so
 * the position-continuity identity check still reads it alive.
 */
import {
  World,
  KIND_MELEE,
  KIND_WORKER,
  STATE_MOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
} from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

suite('ai-scout-party-leash: the probe comes home')

const MIRROR = { x: -40, z: -40 } // Enemy hall is at (40, 40); its mirror is the first scout target.
const HALL = { x: 40, z: 40 } // Enemy hall position (makeWorld).

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

interface Rig {
  world: World
  ai: OpponentAI
  deathX: number
  deathZ: number
}

/** Early rig: mid-early economy (8 workers), no soldiers — the party is the only answer.
 * `roadSeconds` is how long the scout walks before the kill: 5s puts
 * the death ~25 units out (near the hall), 10s puts it ~50 units out
 * (far enough that staged holders cannot evacuate the base — the
 * flee trigger is 32). */
function earlyRig(roadSeconds = 5): Rig {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0) // Scout dispatched toward the mirror.
  advance(ai, world, roadSeconds) // Sim-seconds on the road (~5 units each).
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.removeEntityById(scout!)
  return { world, ai, deathX, deathZ }
}

/**
 * Late rig: like the early rig, plus 6 melee staged at the hall and
 * the AI clock fast-forwarded past the 180s party window (still under
 * the 225s first-wave floor, so the soldiers stay home). The kill
 * answers with a combat squad, not a worker party.
 */
function lateRig(): Rig {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, 45 + (i % 2), 45 + Math.floor(i / 2))
  }
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0) // Scout dispatched toward the mirror.
  advance(ai, world, 5) // 5 sim-seconds on the road (~25 units out).
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  think(ai, world, 185) // Clock to ~191s: past the party window, under the wave floor.
  world.removeEntityById(scout!)
  return { world, ai, deathX, deathZ }
}

test('losing-position gate: a party walking into 5 holders is recalled at once', () => {
  // The scout walks 10s so the death lands ~50 units out: holders
  // staged at the death area are then past the 32-unit flee trigger
  // from the base, so the economy does not evacuate (an evacuated
  // economy sends no party at all — the gate would have nothing to
  // recall). Holders sit on the far side of the death point, inside
  // the leash scan (14) and outside the flee trigger.
  const { world, ai, deathX, deathZ } = earlyRig(10)
  // Five holders at the death area: the 2-worker party is outnumbered
  // by more than the losing margin (2), so the gate fires on the same
  // think the party is dispatched — before it walks into the kill.
  for (let i = 0; i < 5; i += 1) {
    world.spawnUnit('melee', TEAM_PLAYER, deathX - 8 + (i % 3), deathZ - 8 + Math.floor(i / 3))
  }
  think(ai, world, 1.0) // Death detected: party dispatched, then recalled.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.partiesSent, 1, 'the party still goes out')
  assertEqual(resp.leashRecalls, 1, 'the losing gate recalled the party at once')
  assertEqual(resp.leashActive, false, 'no leash once recalled')
  assertEqual(
    targeting(world, KIND_WORKER, HALL.x, HALL.z, 8).length,
    2,
    `both party workers walk home to the hall, got ${targeting(world, KIND_WORKER, HALL.x, HALL.z, 8).length}`,
  )
})

test('cleared area: the late squad comes home once it has arrived and nothing holds the spot', () => {
  const { world, ai, deathX, deathZ } = lateRig()
  think(ai, world, 1.0) // Death detected: the combat squad goes out.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.partiesSent, 1, 'one squad sent')
  assertEqual(resp.leashActive, true, 'the squad is leashed')
  assertEqual(resp.leashRecalls, 0, 'no recall before arrival')
  const squad = targeting(world, KIND_MELEE, deathX, deathZ, 8)
  assertEqual(squad.length, 2, `a 2-soldier squad walks to the death area, got ${squad.length}`)
  // Advance second by second until the recall fires (the squad walks
  // out, arrives, goes idle, and finds the area clear) and assert the
  // orders at once — once home the soldiers go idle at the hall, so a
  // move-target assertion after a fixed advance would miss them.
  let recalled = false
  for (let s = 0; s < 30 && !recalled; s += 1) {
    advance(ai, world, 1)
    recalled = ai.scoutKillResponse().leashRecalls === 1
  }
  assert(recalled, 'the cleared area recalled the squad')
  assertEqual(ai.scoutKillResponse().leashActive, false, 'no leash once recalled')
  assertEqual(
    targeting(world, KIND_MELEE, HALL.x, HALL.z, 8).length,
    2,
    `both squad soldiers walk home to the hall, got ${targeting(world, KIND_MELEE, HALL.x, HALL.z, 8).length}`,
  )
  // Let them finish the walk: both end up standing at the hall.
  advance(ai, world, 15)
  for (const id of squad) {
    const dx = world.positionX[id] - HALL.x
    const dz = world.positionZ[id] - HALL.z
    assert(dx * dx + dz * dz <= 64, `squad soldier ${id} came home to the hall`)
  }
})

test('below the losing margin the squad stays out — the gate does not fire on 3 holders', () => {
  const { world, ai, deathX, deathZ } = lateRig()
  // Three holders against a 2-soldier squad: outnumbered by 1, under
  // the losing margin of 2 — the gate must not fire.
  for (let i = 0; i < 3; i += 1) {
    world.spawnUnit('melee', TEAM_PLAYER, deathX + i, deathZ)
  }
  think(ai, world, 1.0) // Death detected: the squad goes out.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.partiesSent, 1, 'one squad sent')
  assertEqual(resp.leashRecalls, 0, 'no recall below the losing margin')
  assertEqual(resp.leashActive, true, 'the squad stays leashed')
  assertEqual(
    targeting(world, KIND_MELEE, deathX, deathZ, 8).length,
    2,
    `the squad still walks to the death area, got ${targeting(world, KIND_MELEE, deathX, deathZ, 8).length}`,
  )
})

test('a worker party re-tasked by the economy drops off the leash — never yanked home', () => {
  const { world, ai } = earlyRig()
  think(ai, world, 1.0) // Death detected: the 2-worker party goes out.
  assertEqual(ai.scoutKillResponse().partiesSent, 1, 'one party sent')
  assertEqual(ai.scoutKillResponse().leashActive, true, 'the party is leashed')
  // The party walks out (~5s), arrives, goes idle — and the gather
  // system re-tasks idle workers before the leash step runs, so the
  // members leave the probe on their own. No recall may fire.
  advance(ai, world, 30)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.leashRecalls, 0, 'the economy reclaimed the party — no recall fired')
  assertEqual(resp.leashActive, false, 'no leash once the members left the probe')
  assertEqual(
    targeting(world, KIND_WORKER, HALL.x, HALL.z, 8).length,
    0,
    'no party worker was ordered home',
  )
})
