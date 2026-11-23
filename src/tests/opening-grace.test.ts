/**
 * Opening Grace tests — the softening slice (Montz, 2026-11-21).
 *
 * Diagnosis behind the slice (run-evidence/2026-11-21-softening/
 * ANCHOR.md): in the persona chairs the first damage to the player
 * was never the AI — it was the Living Wild treant answering the
 * player's own wood line from ~1:37, while the AI's first march
 * already landed at 4:09–4:40 behind the First Bell and the advance
 * floor. The slice keys every offensive system on one boundary, the
 * First Bell (OPENING_GRACE_SEC = 180):
 *
 *   W1  the forest does not answer before the Second Bell (heat
 *       debt kept but capped at exactly one answer — no banked
 *       burst) — systems/living-wild.ts
 *   W2  the AI's unprovoked shrine contest waits for the bell; the
 *       emergency answer to a live drain does NOT (retaliation) —
 *       ai/opponent.ts contestShrine
 *   (W3, the raised first-march floor, was built, falsified by the
 *   persona proving, and withdrawn — the floors stand as shipped.)
 *
 * Variant (2026-11-23): both graces fire only for HUMAN seats
 * (world.humanSeat) — the staging below sets team 0 human. The
 * seat-scoping itself is pinned in human-seat-grace.test.ts.
 *
 * Defense is never part of the grace: the last test pins a raid
 * answered at full strength at 60s, deep inside the window.
 */
import {
  World,
  KIND_HALL,
  KIND_SHRINE,
  KIND_TREANT,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
} from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { WILD_HEAT_THRESHOLD } from '../systems/living-wild.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

suite('opening grace: the quiet first three minutes')

function treantCount(world: World): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_TREANT) n += 1
  }
  return n
}

test('W1: the forest holds before the Second Bell — debt kept, capped at one answer', () => {
  const world = makeWorld()
  world.humanSeat = [1, 0] // the grace fires for the human seat
  const offender = world.spawnUnit('worker', TEAM_PLAYER, 5, 5)
  // Banked at more than two full thresholds: an unclamped deferral
  // would answer the bell with a burst of consecutive-tick spawns.
  world.wildHeat[TEAM_PLAYER] = WILD_HEAT_THRESHOLD * 2 + 10
  world.wildSiteX[TEAM_PLAYER] = 5
  world.wildSiteZ[TEAM_PLAYER] = 5
  world.wildWorker[TEAM_PLAYER] = offender.id
  stepWorld(world, 60) // 1 sim-second, matchTime ~1: deep in grace.
  assertEqual(treantCount(world), 0, 'no treant rises in the opening minute')
  assert(
    world.wildHeat[TEAM_PLAYER] <= WILD_HEAT_THRESHOLD &&
      world.wildHeat[TEAM_PLAYER] > WILD_HEAT_THRESHOLD - 20,
    `heat debt is deferred but capped at one answer (heat ${world.wildHeat[TEAM_PLAYER].toFixed(1)})`,
  )
  world.matchTime = 200 // Past the First Bell, inside the wild grace:
  // the AI's grace has lifted, the forest's has not (persona proving:
  // a 3:00 treant still executes a soldierless boom build).
  stepWorld(world, 60)
  assertEqual(treantCount(world), 0, 'no treant rises at the First Bell either')
  world.matchTime = 400 // Past the Second Bell: the answer comes due.
  stepWorld(world, 60)
  assertEqual(treantCount(world), 1, 'the treant rises once the Second Bell has rung')
  assert(
    world.wildHeat[TEAM_PLAYER] < WILD_HEAT_THRESHOLD,
    'the spawn consumed the threshold, as before',
  )
})

interface ShrineStage {
  world: World
  soldiers: number[]
  sx: number
  sz: number
}

/**
 * Shrine staging for W2: the shrine is enemy-held on paper. `presence`
 * puts a living player unit on the point (a live drain — the
 * emergency branch's trigger); without it the claim sits empty and
 * only the unprovoked surplus contest could answer. `count` idle
 * enemy melee stage by their hall (aggressor: garrison 1, attack
 * threshold 6, so 10 staged = a surplus of 4 for the normal branch
 * and 9 beyond the garrison for the emergency branch).
 */
function shrineStage(count: number, presence: boolean): ShrineStage {
  const world = makeWorld()
  world.humanSeat = [1, 0] // the contested shrine is the human's
  let shrine = -1
  let hx = 0
  let hz = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) shrine = id
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_ENEMY) {
      hx = world.positionX[id]
      hz = world.positionZ[id]
    }
  }
  assert(shrine !== -1, 'scenario shrine exists')
  const sx = world.positionX[shrine]
  const sz = world.positionZ[shrine]
  world.shrineHeld[shrine] = TEAM_PLAYER
  if (presence) world.spawnUnit('melee', TEAM_PLAYER, sx + 2, sz)
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, hx + 5 + i, hz + 5).id)
  }
  return { world, soldiers, sx, sz }
}

function sortiesOf(world: World, soldiers: number[], sx: number, sz: number): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] !== STATE_ATTACKMOVE) continue
    const dx = world.targetX[id] - sx
    const dz = world.targetZ[id] - sz
    if (dx * dx + dz * dz <= 4) n += 1
  }
  return n
}

function think(personality: AIPersonality, world: World, dt: number): void {
  new OpponentAI(TEAM_ENEMY, 'normal', personality).update(world, dt)
}

test('W2: the unprovoked shrine contest waits for the bell', () => {
  const early = shrineStage(10, false)
  think('aggressor', early.world, 60)
  assertEqual(
    sortiesOf(early.world, early.soldiers, early.sx, early.sz),
    0,
    'no surplus sortie during grace, though the surplus stands ready',
  )
  const late = shrineStage(10, false)
  think('aggressor', late.world, 200)
  assertEqual(
    sortiesOf(late.world, late.soldiers, late.sx, late.sz),
    3,
    'the same surplus sorties once the bell has rung',
  )
})

test('W2: the emergency answer to a live drain is NOT gated', () => {
  const { world, soldiers, sx, sz } = shrineStage(10, true)
  think('aggressor', world, 60)
  assertEqual(
    sortiesOf(world, soldiers, sx, sz),
    3,
    'a live drain is answered during grace — retaliation, not initiation',
  )
})

test('defense is never gated: a raid at 60s is answered at full strength', () => {
  // Choreography mirrors ai-pacing.test.ts's defense pin (raiders at
  // hall −17, vision settle, one think), at 60s instead of 190s: the
  // grace gates sorties and marches, never the home guard.
  const world = makeWorld()
  world.matchTime = 200
  world.bellsRung[0] = 1
  let enemyHallX = 0
  let enemyHallZ = 0
  let playerHallX = 0
  let playerHallZ = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_HALL) continue
    if (world.team[id] === TEAM_PLAYER) {
      playerHallX = world.positionX[id]
      playerHallZ = world.positionZ[id]
    } else {
      enemyHallX = world.positionX[id]
      enemyHallZ = world.positionZ[id]
    }
  }
  world.fog[TEAM_ENEMY].reveal(playerHallX, playerHallZ, 40)
  const soldiers: number[] = []
  for (let i = 0; i < 6; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  const raiders = [
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 17, enemyHallZ).id,
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 17, enemyHallZ + 5).id,
  ]
  world.fog[TEAM_ENEMY].reveal(enemyHallX, enemyHallZ, 40)
  stepWorld(world, 5)
  think('aggressor', world, 60)
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
  assertEqual(onThreat, 6, `all 6 home soldiers on the threat during grace, ${onThreat} were`)
  assert(defendOrders >= 2, `defend() itself issued orders during grace (${defendOrders} attack-moves)`)
})
