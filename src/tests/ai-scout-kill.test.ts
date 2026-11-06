/**
 * AI scout-kill response tests (Montz, 2026-11-04): a dead scout is
 * never free. Slice 8 replaced a killed scout with one worker
 * re-running the route; this slice answers the kill itself:
 *
 *   - a scouting party goes to the death area (2 workers on the first
 *     kill, 3 workers + a melee escort from the second);
 *   - the first march waits on the party's report: +30s per kill,
 *     capped at +60s, on top of the per-personality advance floor;
 *   - both effects are capped (at most 3 parties, delay at most 60s)
 *     so repeated kills can never stall the attack or spam scouts;
 *   - defense is never held — only the offensive march waits.
 *
 * Numbers are the proposal under measurement (see the scratch probe),
 * pinned here so a later tune has to move the pins deliberately.
 * Headless and deterministic. Staging mirrors ai-pacing.test.ts (bell
 * rung, player hall scouted, soldiers staged by the AI hall, shrine
 * held so the contest step cannot siphon staged soldiers).
 *
 * Retune (Montz, 2026-11-06 — proving NOT PROVEN 2026-11-05): in
 * AI-vs-AI the kills land at 248–624s, past the 180s party window and
 * past both teams' first march, so the response never fired. The
 * retune answers late kills too: a kill after the scouting window
 * sends a combat squad (2 soldiers, 3 from the second kill) instead
 * of workers, and the kill holds the NEXT march
 * (nextMarchNotBeforeSec), not only the first. Early-kill behavior is
 * unchanged — the tests above still pin it.
 */
import {
  World,
  KIND_HALL,
  KIND_MELEE,
  KIND_SHRINE,
  KIND_WORKER,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  STATE_MOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
} from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { serializeWorld, deserializeWorld, type WorldSave } from '../session/save-load.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

suite('ai-scout-kill: response to a killed scout')

const MIRROR = { x: -40, z: -40 } // Enemy hall is at (40, 40); its mirror is the first scout target.

interface Staged {
  world: World
  soldiers: number[]
  enemyHallX: number
  enemyHallZ: number
}

function armedScenario(count: number, holdShrine = false): Staged {
  const world = makeWorld()
  world.matchTime = 200
  world.bellsRung[0] = 1
  let enemyHallX = 0
  let enemyHallZ = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE && holdShrine) world.shrineHeld[id] = TEAM_ENEMY
    if (world.kind[id] !== KIND_HALL) continue
    if (world.team[id] === TEAM_ENEMY) {
      enemyHallX = world.positionX[id]
      enemyHallZ = world.positionZ[id]
    }
  }
  // NOTE: the player hall is deliberately NOT revealed here — unlike
  // ai-pacing's rig. scout() early-returns once the enemy hall is
  // explored, so revealing it would mean no scout is ever dispatched
  // and the kill under test could never happen. attack() still
  // marches: with the hall unexplored it takes the mirror guess, and
  // the assertions below count ATTACKMOVE orders, not the target.
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  return { world, soldiers, enemyHallX, enemyHallZ }
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

function attackersOf(world: World, soldiers: number[]): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] === STATE_ATTACKMOVE) n += 1
  }
  return n
}

/** The live scout: the moving enemy worker headed for the mirror target. */
function liveScout(world: World): number | undefined {
  return targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1)[0]
}

function think(ai: OpponentAI, world: World, dt: number): void {
  ai.update(world, dt)
}

/**
 * Advance the world `seconds` sim-seconds while letting the AI think at
 * its own cadence (one think per game-second on normal). The
 * position-continuity identity check in scoutAlive() assumes no more
 * than one think gap of travel between thinks — stepping the world
 * several seconds without a think would read as the scout
 * teleporting, i.e. a false death. Real matches think while the world
 * runs; so must the staging. (60 ticks = 1 sim-second: STEP = 1/60.)
 */
function advance(ai: OpponentAI, world: World, seconds: number): void {
  for (let s = 0; s < seconds; s += 1) {
    stepWorld(world, 60)
    think(ai, world, 1.0)
  }
}

test('no kill: response stays zero and the single scout stays out', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  for (let i = 0; i < 5; i += 1) think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 0, 'no kills counted without a death')
  assertEqual(resp.partiesSent, 0, 'no party without a death')
  assertEqual(resp.delaySec, 0, 'no delay without a death')
  assertEqual(targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1).length, 1, 'exactly one scout on the route')
})

test('first kill: a 2-worker party goes to the death area, plus the replacement scout', () => {
  const world = makeWorld()
  // Stage a mid-early economy so the party gate (5+ workers) passes.
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  // No soldiers staged on purpose: the AI has no army yet, so there
  // is no garrison to thin — the party is its only answer to the kill,
  // and the gate allows it. (A garrison-only AI with soldiers but no
  // surplus gets no party; see the gate test below.)
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0) // Scout dispatched toward the mirror.
  advance(ai, world, 5) // 5 sim-seconds on the road (~25 units out).
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.removeEntityById(scout!)
  think(ai, world, 1.0) // Death detected: replacement + party.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'one kill counted')
  assertEqual(resp.partiesSent, 1, 'one party sent')
  assertEqual(resp.delaySec, 30, 'first kill delays the march by 30s')
  // The replacement re-runs the route (mirror target); the party goes
  // to the death area. Nearest resource node is ~14 units from a
  // mid-route death, so tolerance 8 separates party from gatherers.
  assertEqual(targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1).length, 1, 'one replacement scout on the route')
  assertEqual(
    targeting(world, KIND_WORKER, deathX, deathZ, 8).length,
    2,
    `a 2-worker party at the death area, got ${targeting(world, KIND_WORKER, deathX, deathZ, 8).length}`,
  )
})

test('one kill delays the first attack by exactly 30s — and it still attacks', () => {
  // Kill arm: held at the 225s floor, marching at 255s.
  const kill = armedScenario(8, true)
  const killAi = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(killAi, kill.world, 1.0)
  const scout = liveScout(kill.world)
  assert(scout !== undefined, 'a scout was dispatched')
  kill.world.removeEntityById(scout!)
  think(killAi, kill.world, 1.0) // gameTime 2: the kill is detected EARLY.
  // (Retune note: without this detection think, the kill would first be
  // seen at the 224s jump below — gameTime 225, past the window — and
  // would answer with a 2-soldier squad instead of the worker party,
  // which is correct late-kill behavior but not what this test pins.
  // A real kill is detected on the next think, ~1s later, so detect
  // it here and keep this test the early-kill shape it names.)
  think(killAi, kill.world, 223) // gameTime 225: the floor, not yet the delayed floor.
  assertEqual(attackersOf(kill.world, kill.soldiers), 0, 'no advance at the floor after a kill')
  assertEqual(killAi.scoutKillResponse().delaySec, 30, 'delay is 30s after one kill')
  think(killAi, kill.world, 20) // gameTime 245: past the forced-attack line (240s) —
  // the forced branch must not bypass the delay either.
  assertEqual(attackersOf(kill.world, kill.soldiers), 0, 'no advance at 245s either — forced does not bypass the delay')
  think(killAi, kill.world, 10) // gameTime 255: floor + delay.
  const n = attackersOf(kill.world, kill.soldiers)
  assert(n >= 6, `the delayed march still goes at 255s (8 staged, 1 garrison), sent ${n}`)

  // Baseline arm, same staging, no kill: marching at the 225s floor.
  const base = armedScenario(8, true)
  const baseAi = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(baseAi, base.world, 1.0)
  think(baseAi, base.world, 224)
  const m = attackersOf(base.world, base.soldiers)
  assert(m >= 6, `no-kill baseline marches at the floor, sent ${m}`)
  assertEqual(baseAi.scoutKillResponse().delaySec, 0, 'no delay without a kill')
})

test('second kill: a 3-worker party plus one melee escort, delay 45s', () => {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  // Two idle melee by the hall: one to escort, one to stay home.
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  world.spawnUnit('melee', TEAM_ENEMY, 46, 46)
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0)
  // Kill 1: at the dispatch point, so its death area stays near the hall.
  let scout = liveScout(world)
  assert(scout !== undefined, 'first scout dispatched')
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  assertEqual(ai.scoutKillResponse().partiesSent, 1, 'first party sent')
  // Kill 2: the replacement, 5 sim-seconds down the road.
  advance(ai, world, 5)
  scout = liveScout(world)
  assert(scout !== undefined, 'replacement scout dispatched')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 2, 'two kills counted')
  assertEqual(resp.partiesSent, 2, 'second party sent')
  assertEqual(resp.delaySec, 45, 'second kill delays the march by 45s')
  assertEqual(
    targeting(world, KIND_WORKER, deathX, deathZ, 8).length,
    3,
    `a 3-worker party at the second death area, got ${targeting(world, KIND_WORKER, deathX, deathZ, 8).length}`,
  )
  assertEqual(
    targeting(world, KIND_MELEE, deathX, deathZ, 8).length,
    1,
    `exactly one melee escort walks with the party, got ${targeting(world, KIND_MELEE, deathX, deathZ, 8).length}`,
  )
})

test('four kills: parties cap at 3, delay caps at 60s, the attack still goes', () => {
  const staged = armedScenario(10, true)
  const { world, soldiers } = staged
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 3) * 2, 44 + Math.floor(i / 3) * 2)
  }
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(ai, world, 1.0)
  for (let kill = 0; kill < 4; kill += 1) {
    const scout = liveScout(world)
    assert(scout !== undefined, `a scout is out for kill ${kill + 1}`)
    world.removeEntityById(scout!)
    think(ai, world, 1.0)
  }
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 4, 'four kills counted')
  assertEqual(resp.partiesSent, 3, 'parties cap at 3 no matter how many kills')
  assertEqual(resp.delaySec, 60, 'delay caps at 60s')
  // The march still goes — at the capped floor, not never.
  think(ai, world, 280) // gameTime 285: floor 225 + capped delay 60.
  const n = attackersOf(world, soldiers)
  assert(n >= 6, `four kills still attack at 285s (10 staged, 1 garrison, escorts out), sent ${n}`)
})

test('a recycled scout id does not hide the kill: the next spawn wears the id', () => {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  // One soldier beyond the (zero, early) garrison, so the party gate passes.
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0)
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deadId = scout!
  world.removeEntityById(deadId)
  // The very next spawn reuses the freed id (LIFO freeIds) — the
  // classic false-alive trap: an "alive" check alone would read the
  // newborn worker as the scout surviving, and the kill would never
  // be answered. The newborn is placed far from the death area, so
  // position continuity — not the id — is what tells them apart.
  const newborn = world.spawnUnit('worker', TEAM_ENEMY, 0, 0).id
  assertEqual(newborn, deadId, 'the newborn reuses the dead scout id')
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'the kill is counted despite the recycled id')
  assertEqual(resp.partiesSent, 1, 'the party still goes out')
  assertEqual(targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1).length, 1, 'a replacement scout is dispatched')
})

test('a scout killed after finding the enemy is still answered — party, delay, no replacement', () => {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  // One soldier beyond the (zero, early) garrison, so the party gate passes.
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  const ai = new OpponentAI(TEAM_ENEMY)
  think(ai, world, 1.0) // Scout dispatched; the hall is not yet explored.
  advance(ai, world, 5) // 5 sim-seconds on the road; each think records the position.
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  // The scout's walk explored the enemy hall in the meantime: reveal it
  // outright — from here the old layout returned before ever looking
  // at the scout, so the kill that follows was invisible forever.
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40)
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'the kill is counted after discovery')
  assertEqual(resp.partiesSent, 1, 'the party still goes out')
  assertEqual(resp.delaySec, 30, 'the delay is still set')
  assertEqual(targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1).length, 0, 'no replacement scout once the enemy is found')
  assertEqual(
    targeting(world, KIND_WORKER, deathX, deathZ, 8).length,
    2,
    `a 2-worker party at the death area, got ${targeting(world, KIND_WORKER, deathX, deathZ, 8).length}`,
  )
})

test('a garrison-only AI gets the delay but no party — it must not stake what it cannot back', () => {
  const world = makeWorld()
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  // Defender, 2 soldiers: exactly the early garrison (2), zero surplus
  // beyond it — the shrine integration shape, where staking workers
  // across the map would flip an empty shrine by accident and answer
  // a drain the garrison is supposed to leave alone.
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  world.spawnUnit('melee', TEAM_ENEMY, 46, 46)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'defender')
  think(ai, world, 1.0)
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'the kill is counted')
  assertEqual(resp.partiesSent, 0, 'no party without a soldier beyond the garrison')
  assertEqual(resp.delaySec, 30, 'the delay still stands without the party')
  assertEqual(targeting(world, KIND_WORKER, MIRROR.x, MIRROR.z, 1).length, 1, 'the replacement scout still goes out')
})

test('defense is not delayed by a kill: a raid is answered before the floor', () => {
  const { world, soldiers, enemyHallX, enemyHallZ } = armedScenario(6)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(ai, world, 1.0)
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout was dispatched')
  world.removeEntityById(scout!)
  think(ai, world, 1.0) // Kill answered (delay set) — defense must not wait on it.
  assertEqual(ai.scoutKillResponse().delaySec, 30, 'delay is set')
  const raiders = [
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 16, enemyHallZ).id,
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 16, enemyHallZ + 5).id,
  ]
  world.fog[TEAM_ENEMY].reveal(enemyHallX, enemyHallZ, 40)
  stepWorld(world, 5) // vision settles, as in the ai-pacing raid rig
  think(ai, world, 190)
  let onThreat = 0
  let defendOrders = 0
  for (const id of soldiers) {
    const st = world.state[id]
    if (st !== STATE_ATTACKMOVE && st !== STATE_ATTACK) continue
    const nearRaider = raiders.some((r) => {
      const dx = world.targetX[id] - world.positionX[r]
      const dz = world.targetZ[id] - world.positionZ[r]
      return dx * dx + dz * dz <= 100
    })
    if (!nearRaider) continue
    onThreat += 1
    if (st === STATE_ATTACKMOVE) defendOrders += 1
  }
  assertEqual(onThreat, 6, `all 6 home soldiers on the threat pre-floor, ${onThreat} were`)
  assert(defendOrders >= 2, `defend() itself issued orders pre-floor (${defendOrders} attack-moves)`)
})

/**
 * Medic fix (QA FAIL 2026-11-05): loading an earlier save fabricated
 * a scout kill. The in-session load path leaves the OpponentAI object
 * untouched, so the restored scout (save-time position) failed the
 * AI's post-save position-continuity check on the first think after
 * load: save at 15s, play to 120s, load, one think → kills 0→1,
 * delay 0→30. The save now carries the scout state (see
 * getScoutState/restoreScoutState), so the restored AI continues the
 * restored timeline. These tests pin the load behavior: a load must
 * never increment scoutKills or apply a delay for a kill that did not
 * happen after the load. Staging mirrors QA's saveload probe (AI
 * registered as a system, one think per sim-second).
 */
test('load does not fabricate a kill: save at 15s, play to 120s, load, one think', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  world.registerSystem(ai)
  think(ai, world, 1.0)
  advance(ai, world, 14) // ~15s: scout mid-route, enemy not yet found.
  const atSave = ai.scoutKillResponse()
  const savedState = ai.getScoutState()
  assertEqual(atSave.kills, 0, 'no kill before the save')
  const save = serializeWorld(world, world.tick, [])
  advance(ai, world, 105) // ~120s: scout found the enemy, now gathering.
  assertEqual(ai.scoutKillResponse().kills, 0, 'no kill in the played-on timeline either')
  deserializeWorld(world, save)
  think(ai, world, 1.0)
  const after = ai.scoutKillResponse()
  assertEqual(after.kills, atSave.kills, 'load fabricates no kill')
  assertEqual(after.delaySec, atSave.delaySec, 'load applies no delay')
  assertEqual(after.partiesSent, atSave.partiesSent, 'load sends no party')
  const restored = ai.getScoutState()
  assertEqual(restored.scoutId, savedState.scoutId, 'scout identity restored to the save point')
  assertEqual(restored.lastScoutX, savedState.lastScoutX, 'scout last-seen X restored to the save point')
  assertEqual(restored.lastScoutZ, savedState.lastScoutZ, 'scout last-seen Z restored to the save point')
  assertEqual(restored.scoutTargets.length, savedState.scoutTargets.length, 'route queue restored to the save point')
})

test('a kill from the discarded timeline does not survive the load', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  world.registerSystem(ai)
  think(ai, world, 1.0)
  advance(ai, world, 14) // ~15s: scout mid-route.
  const save = serializeWorld(world, world.tick, [])
  // A kill happens after the save, in the timeline the load discards.
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is on the road')
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  assertEqual(ai.scoutKillResponse().kills, 1, 'the post-save kill is counted before the load')
  assertEqual(ai.scoutKillResponse().delaySec, 30, 'the post-save kill sets the delay')
  deserializeWorld(world, save)
  think(ai, world, 1.0)
  const after = ai.scoutKillResponse()
  assertEqual(after.kills, 0, 'the discarded kill is gone after the load')
  assertEqual(after.delaySec, 0, 'the discarded delay is gone after the load')
  assertEqual(after.partiesSent, 0, 'no party from the discarded kill')
})

test('a real kill after a load is still answered', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  world.registerSystem(ai)
  think(ai, world, 1.0)
  advance(ai, world, 14) // ~15s: scout mid-route.
  const save = serializeWorld(world, world.tick, [])
  advance(ai, world, 105) // ~120s: scout found the enemy, now gathering.
  deserializeWorld(world, save)
  think(ai, world, 1.0) // The load itself answers nothing.
  assertEqual(ai.scoutKillResponse().kills, 0, 'no phantom kill on load')
  const scout = liveScout(world)
  assert(scout !== undefined, 'the restored scout is back on the route')
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'the post-load kill is counted')
  assertEqual(resp.delaySec, 30, 'the post-load kill sets the delay')
})

test('a save without scout state still loads (pre-fix saves)', () => {
  const world = makeWorld()
  const ai = new OpponentAI(TEAM_ENEMY)
  world.registerSystem(ai)
  think(ai, world, 1.0)
  advance(ai, world, 5)
  const legacy = serializeWorld(world, world.tick, []) as unknown as Record<string, unknown>
  delete legacy.scoutState
  const target = makeWorld()
  target.registerSystem(new OpponentAI(TEAM_ENEMY))
  deserializeWorld(target, legacy as unknown as WorldSave)
  assertEqual(target.tick, world.tick, 'legacy save restores the tick')
})

/**
 * Retune tests (Montz, 2026-11-06): late kills — the shape proving
 * measured (kills at 248–624s). Staging note: the soldiers are spawned
 * AFTER the clock reaches 300s. If they were staged before the floor,
 * attack() would have marched them at 225s and none would be idle for
 * the squad pick — the kill think runs scout() before attack(), so a
 * squad picked on the kill think is never re-tasked by the march.
 */
test('late kill: a 2-soldier squad goes to the death area and the next march waits', () => {
  const { world, enemyHallX, enemyHallZ } = armedScenario(0, true)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(ai, world, 1.0) // Scout dispatched toward the mirror.
  advance(ai, world, 5) // 5 sim-seconds on the road (~25 units out).
  think(ai, world, 294) // gameTime 300: past the window and the floor, scout still out.
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is still on the road at 300s')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.removeEntityById(scout!)
  think(ai, world, 1.0) // gameTime 301: kill detected, squad out, march held.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 1, 'the late kill is counted')
  assertEqual(resp.partiesSent, 1, 'one party sent for the late kill')
  assertEqual(resp.delaySec, 30, 'the late kill still sets the 30s delay')
  assertEqual(resp.wavesHeld, 1, 'the hold blocked exactly one wave')
  assertEqual(
    targeting(world, KIND_MELEE, deathX, deathZ, 8).length,
    2,
    `a 2-soldier squad at the death area, got ${targeting(world, KIND_MELEE, deathX, deathZ, 8).length}`,
  )
  assertEqual(
    targeting(world, KIND_WORKER, deathX, deathZ, 8).length,
    0,
    'no workers walk into the mid-game death area',
  )
  assertEqual(attackersOf(world, soldiers), 0, 'no march while the hold runs')
  assertEqual(ai.offensiveMarchTimes().length, 0, 'no offensive dispatch recorded while held')
  think(ai, world, 30) // gameTime 331: the hold (kill at 301 + 30s) expires.
  const n = attackersOf(world, soldiers)
  assert(n >= 4, `the held march still goes at 331s (8 staged, 2 in the squad, 2 garrison), sent ${n}`)
  assertEqual(ai.offensiveMarchTimes()[0], 331, 'the march log records the held wave at 331s')
})

test('second kill late: a 3-soldier squad, delay 45s, hold until kill+45', () => {
  const world = makeWorld()
  // Bell rung and shrine held, as in armedScenario: attack() runs, and
  // the shrine contest cannot siphon the staged soldiers.
  world.matchTime = 200
  world.bellsRung[0] = 1
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) world.shrineHeld[id] = TEAM_ENEMY
  }
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 44 + (i % 2) * 2, 44 + Math.floor(i / 2) * 2)
  }
  world.spawnUnit('melee', TEAM_ENEMY, 45, 45)
  world.spawnUnit('melee', TEAM_ENEMY, 46, 46)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  think(ai, world, 1.0)
  // Kill 1 (early): the 2-worker party + escort go out; the delay is set.
  let scout = liveScout(world)
  assert(scout !== undefined, 'first scout dispatched')
  world.removeEntityById(scout!)
  think(ai, world, 1.0)
  assertEqual(ai.scoutKillResponse().partiesSent, 1, 'first party sent')
  // Kill 2 (late): the replacement, killed at 300s.
  think(ai, world, 298) // gameTime 300.
  const { enemyHallX, enemyHallZ } = (() => {
    let hx = 0
    let hz = 0
    for (const id of world.entities.keys()) {
      if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_ENEMY) {
        hx = world.positionX[id]
        hz = world.positionZ[id]
      }
    }
    return { enemyHallX: hx, enemyHallZ: hz }
  })()
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  scout = liveScout(world)
  assert(scout !== undefined, 'replacement scout still on the road at 300s')
  const deathX = world.positionX[scout!]
  const deathZ = world.positionZ[scout!]
  world.removeEntityById(scout!)
  think(ai, world, 1.0) // gameTime 301.
  const resp = ai.scoutKillResponse()
  assertEqual(resp.kills, 2, 'two kills counted')
  assertEqual(resp.partiesSent, 2, 'second party sent')
  assertEqual(resp.delaySec, 45, 'second kill delays by 45s')
  assertEqual(resp.wavesHeld, 1, 'the late hold blocked one wave')
  assertEqual(
    targeting(world, KIND_MELEE, deathX, deathZ, 8).length,
    3,
    `a 3-soldier squad at the second death area, got ${targeting(world, KIND_MELEE, deathX, deathZ, 8).length}`,
  )
  assertEqual(attackersOf(world, soldiers), 0, 'no march while the second hold runs')
  think(ai, world, 45) // gameTime 346: the hold (kill at 301 + 45s) expires.
  const n = attackersOf(world, soldiers)
  assert(n >= 3, `the held march still goes at 346s, sent ${n}`)
})

test('the next-march hold survives a load: save at 301, load, march still held until the saved hold', () => {
  const { world, enemyHallX, enemyHallZ } = armedScenario(0, true)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor')
  world.registerSystem(ai)
  think(ai, world, 1.0)
  advance(ai, world, 5)
  think(ai, world, 294) // gameTime ~300 (see the note below).
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  const scout = liveScout(world)
  assert(scout !== undefined, 'a scout is still on the road at 300s')
  world.removeEntityById(scout!)
  think(ai, world, 1.0) // Late kill answered, hold set until kill + 30s.
  // NOTE: the AI is registered as a system here (deserializeWorld
  // needs it to restore), so advance() thinks it twice per second —
  // once via the world step, once via the explicit think — and the
  // clock at the kill is ~306, not 301. The hold is therefore read
  // from the save itself and the march is driven relative to it, not
  // to a hardcoded second. (gameTime is AI-internal and not persisted
  // — the parked B4 exclusion — so the clock keeps its played-on
  // value across the load; only the hold is restored.)
  const killGameTime = (ai as unknown as { gameTime: number }).gameTime
  const savedHold = ai.getScoutState().nextMarchNotBeforeSec
  assertEqual(savedHold, killGameTime + 30, 'the save carries the hold until kill + 30s')
  const save = serializeWorld(world, world.tick, [])
  advance(ai, world, 10) // Play on: the hold runs down, the march goes.
  assert(ai.scoutKillResponse().kills === 1, 'the kill stands in the played-on timeline')
  deserializeWorld(world, save)
  think(ai, world, 1.0) // The load itself answers nothing.
  assertEqual(ai.scoutKillResponse().kills, 1, 'the pre-save kill survives the load')
  assertEqual(
    ai.getScoutState().nextMarchNotBeforeSec,
    savedHold,
    'the restored hold still runs until the saved hold',
  )
  const afterLoadGameTime = (ai as unknown as { gameTime: number }).gameTime
  think(ai, world, savedHold - afterLoadGameTime - 1) // 1s before the restored hold expires.
  assertEqual(attackersOf(world, soldiers), 0, 'no march inside the restored hold')
  think(ai, world, 2) // Past the restored hold.
  const n = attackersOf(world, soldiers)
  assert(n >= 4, `the march still goes when the restored hold expires, sent ${n}`)
})
