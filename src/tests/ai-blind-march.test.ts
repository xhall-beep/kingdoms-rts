/**
 * AI blind-march guess tests — audit item #4 (2026-11-06).
 *
 * findTarget's blind guess (enemy hall not yet explored) must be the TRUE
 * mirror of the AI's own hall: the shipped map is diagonal — halls at
 * (-40,-40) and (40,40) — so the mirror negates BOTH axes. The pre-fix
 * guess negated only x ({-hx, hz}), sending the first march to an empty
 * corner (40,-40) / (-40,40) until the search fallback corrected it.
 *
 * Staging mirrors ai-pacing.test.ts: bell rung, 8 idle melee staged by the
 * AI's hall, and the AI driven by a single update() past its opening floor.
 * Nothing is revealed in fog and the world is never stepped, so the enemy
 * hall stays unexplored and the march target IS the blind guess. The scout
 * never goes out: the single think lands past the 180 s scout window.
 * Headless and deterministic.
 */
import { KIND_HALL, STATE_ATTACKMOVE, TEAM_ENEMY, TEAM_PLAYER } from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'
import type { World } from '../core/World.ts'

suite('ai-blind-march: blind guess is the true mirror')

function hallPos(world: World, team: 0 | 1): { x: number; z: number } {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_HALL && world.team[id] === team) {
      return { x: world.positionX[id], z: world.positionZ[id] }
    }
  }
  throw new Error(`no hall for team ${team}`)
}

/** Stage a ready wave for `team` with fog memory empty; return the distinct attack-move targets the wave was sent to. */
function blindMarchTargets(team: 0 | 1, personality: AIPersonality, thinkSec: number): { targets: Set<string>; sent: number; enemy: { x: number; z: number } } {
  const world = makeWorld()
  world.bellsRung[0] = 1
  const own = hallPos(world, team)
  const enemy = hallPos(world, team === TEAM_PLAYER ? TEAM_ENEMY : TEAM_PLAYER)
  const soldiers: number[] = []
  for (let i = 0; i < 8; i += 1) {
    soldiers.push(world.spawnUnit('melee', team, own.x + 5 + i, own.z + 5).id)
  }
  new OpponentAI(team, 'normal', personality).update(world, thinkSec)
  const targets = new Set<string>()
  let sent = 0
  for (const id of soldiers) {
    if (world.state[id] === STATE_ATTACKMOVE) {
      sent += 1
      targets.add(`${world.targetX[id]},${world.targetZ[id]}`)
    }
  }
  return { targets, sent, enemy }
}

test('team 0 blind march targets the enemy hall at (40,40), not the empty (40,-40)', () => {
  const { targets, sent, enemy } = blindMarchTargets(TEAM_PLAYER, 'expander', 300)
  assert(sent >= 4, `wave dispatched (sent ${sent})`)
  assertEqual(targets.size, 1, `one march target, got ${JSON.stringify([...targets])}`)
  assert(targets.has(`${enemy.x},${enemy.z}`), `march target is the enemy hall (${enemy.x},${enemy.z}), got ${JSON.stringify([...targets])}`)
})

test('team 1 blind march targets the enemy hall at (-40,-40), not the empty (-40,40)', () => {
  const { targets, sent, enemy } = blindMarchTargets(TEAM_ENEMY, 'expander', 300)
  assert(sent >= 4, `wave dispatched (sent ${sent})`)
  assertEqual(targets.size, 1, `one march target, got ${JSON.stringify([...targets])}`)
  assert(targets.has(`${enemy.x},${enemy.z}`), `march target is the enemy hall (${enemy.x},${enemy.z}), got ${JSON.stringify([...targets])}`)
})

test('aggressor blind march also uses the true mirror (team 1, 260s think)', () => {
  const { targets, sent, enemy } = blindMarchTargets(TEAM_ENEMY, 'aggressor', 260)
  assert(sent >= 4, `wave dispatched (sent ${sent})`)
  assert(targets.has(`${enemy.x},${enemy.z}`), `march target is the enemy hall (${enemy.x},${enemy.z}), got ${JSON.stringify([...targets])}`)
})
