/**
 * AI shrine defense (shrine audit 2026-10-22).
 *
 * Under presence-sustained drain, an enemy holding the shrine with a unit
 * on the point bleeds the AI 5 VP/s. The old contest path waited for an
 * idle surplus beyond the attack threshold — a surplus the early game
 * never produces — so the AI bled out with soldiers standing at home.
 * The emergency answer: any idle soldier beyond the garrison marches.
 */
import { TEAM_PLAYER, TEAM_ENEMY, KIND_SHRINE, KIND_MELEE, KIND_RANGED, STATE_IDLE } from '../core/World.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { CAPTURE_RADIUS } from '../systems/shrines.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('shrines: AI answers a live drain')

test('AI contests an enemy-held shrine before the drain kills it', () => {
  const world = makeWorld() // production-faithful factory, seeded scenario
  world.registerSystem(new OpponentAI(TEAM_ENEMY, 'normal', 'expander'))

  let shrine = -1
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) shrine = id
  }
  assert(shrine !== -1, 'scenario shrine exists')

  // Enemy (team 0) camps the point with a single melee: sole presence at
  // the first check takes the shrine and starts the drain on the AI.
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  // The AI has three idle soldiers at home — far below its attack
  // threshold surplus, exactly the early-game shape that used to bleed out.
  world.spawnUnit('melee', TEAM_ENEMY, 34, 34)
  world.spawnUnit('melee', TEAM_ENEMY, 36, 34)
  world.spawnUnit('melee', TEAM_ENEMY, 34, 36)

  let drainStarted = false
  let soldierReached = false
  for (let sec = 0; sec < 45; sec += 1) {
    stepWorld(world, 60)
    if (world.victoryPoints[TEAM_ENEMY] < 1000) drainStarted = true
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_ENEMY) continue
      const k = world.kind[id]
      if (k !== KIND_MELEE && k !== KIND_RANGED) continue
      const d = Math.hypot(world.positionX[id], world.positionZ[id])
      if (d <= CAPTURE_RADIUS + 4) soldierReached = true
    }
  }

  assert(drainStarted, 'the enemy drain actually started (test is not vacuous)')
  assert(soldierReached, 'an AI soldier marched to the shrine')
  assert(
    world.victoryPoints[TEAM_ENEMY] > 700,
    `AI answered before losing 300 VP (VP left: ${world.victoryPoints[TEAM_ENEMY]})`,
  )
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'AI retook the shrine')
})

/** The scenario's shrine entity id and position. */
function shrineOf(world: ReturnType<typeof makeWorld>): { shrine: number; sx: number; sz: number } {
  let shrine = -1
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) shrine = id
  }
  assert(shrine !== -1, 'scenario shrine exists')
  return { shrine, sx: world.positionX[shrine], sz: world.positionZ[shrine] }
}

test('emergency answer does not draw on the garrison when no surplus exists', () => {
  const world = makeWorld()
  const { shrine, sx, sz } = shrineOf(world)
  // The enemy holds the point with a single unit: VP is draining now.
  world.spawnUnit('melee', TEAM_PLAYER, sx + 2, sz)
  // A defender AI whose whole army IS its garrison: two idle soldiers,
  // garrison 2 in the opening (defender personality) — zero idle surplus
  // beyond it. The emergency path spends only genuine surplus beyond
  // the garrison, so this drain runs unopposed. A below-garrison stake
  // was tried (87a6cc1) and reverted: the dip/elf audit (2026-10-23)
  // measured the staked parties dying at home — the attack-move order
  // engages the home siege first — with 0 of 103 dips buying hold time.
  // A garrison-only army dispatching NOTHING is the accepted, measured
  // behavior until a redesign (not a retune) replaces it.
  const s1 = world.spawnUnit('melee', TEAM_ENEMY, 34, 34).id
  const s2 = world.spawnUnit('melee', TEAM_ENEMY, 36, 34).id
  stepWorld(world, 5)
  world.shrineHeld[shrine] = TEAM_PLAYER // The camper's claim (5 steps run no capture check).
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 2)
  for (const s of [s1, s2]) {
    assertEqual(world.state[s], STATE_IDLE, 'a garrison soldier stays home — no dip below the garrison')
  }
})

test('no emergency dip below the garrison while the claim sits empty', () => {
  const world = makeWorld()
  const { shrine } = shrineOf(world)
  // Enemy claim, but nobody on the point: presence-sustained drain
  // means nothing is bleeding, so the garrison stays home — the
  // below-garrison answer is for a live drain only, and the normal
  // contest path still waits for its surplus.
  const s1 = world.spawnUnit('melee', TEAM_ENEMY, 34, 34).id
  const s2 = world.spawnUnit('melee', TEAM_ENEMY, 36, 34).id
  stepWorld(world, 5)
  world.shrineHeld[shrine] = TEAM_PLAYER
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 2)
  assertEqual(world.state[s1], STATE_IDLE, 'garrison soldier 1 stays home')
  assertEqual(world.state[s2], STATE_IDLE, 'garrison soldier 2 stays home')
})

test('a garrison-only AI does not answer a live drain — the drain runs (integration)', () => {
  const world = makeWorld()
  world.registerSystem(new OpponentAI(TEAM_ENEMY, 'normal', 'defender'))
  const { shrine, sx, sz } = shrineOf(world)
  world.spawnUnit('melee', TEAM_PLAYER, sx + 2, sz)
  world.spawnUnit('melee', TEAM_ENEMY, 34, 34)
  world.spawnUnit('melee', TEAM_ENEMY, 36, 34)

  // Restored semantics (dip revert, 2026-10-23 audit): with no idle
  // surplus beyond the garrison, nobody is staked on the point — the
  // garrison stays home and the drain runs for the full window. This
  // is the accepted, measured behavior until a redesign replaces it.
  let drainStarted = false
  let soldierReached = false
  for (let sec = 0; sec < 45; sec += 1) {
    stepWorld(world, 60)
    if (world.victoryPoints[TEAM_ENEMY] < 1000) drainStarted = true
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_ENEMY) continue
      const k = world.kind[id]
      if (k !== KIND_MELEE && k !== KIND_RANGED) continue
      const d = Math.hypot(world.positionX[id] - sx, world.positionZ[id] - sz)
      if (d <= CAPTURE_RADIUS + 4) soldierReached = true
    }
  }

  assert(drainStarted, 'the enemy drain actually started (test is not vacuous)')
  assert(!soldierReached, 'no garrison soldier marched to the shrine')
  assertEqual(world.shrineHeld[shrine], TEAM_PLAYER, 'the drain holder keeps the shrine')
})
