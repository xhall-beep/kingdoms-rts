/**
 * AI shrine defense (shrine audit 2026-10-22).
 *
 * Under presence-sustained drain, an enemy holding the shrine with a unit
 * on the point bleeds the AI 5 VP/s. The old contest path waited for an
 * idle surplus beyond the attack threshold — a surplus the early game
 * never produces — so the AI bled out with soldiers standing at home.
 * The emergency answer: any idle soldier beyond the garrison marches.
 */
import { TEAM_PLAYER, TEAM_ENEMY, KIND_SHRINE, KIND_MELEE, KIND_RANGED } from '../core/World.ts'
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
