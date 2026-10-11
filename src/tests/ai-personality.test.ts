/**
 * AI personality tests — verifies that the aggressor / defender / expander
 * personalities actually change AI decisions (resolved tuning + behavior).
 * Headless and deterministic.
 */
import { World, KIND_HALL, STATE_ATTACKMOVE, TEAM_ENEMY, TEAM_PLAYER } from '../core/World.ts'
import { OpponentAI, type AIDifficulty, type AIPersonality } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'

function tuning(diff: AIDifficulty, pers: AIPersonality) {
  return new OpponentAI(TEAM_ENEMY, diff, pers).decisionTuning()
}

suite('ai-personality: tuning')

test('constructor stores difficulty and personality', () => {
  const ai = new OpponentAI(TEAM_ENEMY, 'hard', 'aggressor')
  assertEqual(ai.difficulty, 'hard', 'difficulty stored')
  assertEqual(ai.personality, 'aggressor', 'personality stored')
})

test('defaults match the old behavior (normal/expander)', () => {
  const ai = new OpponentAI(TEAM_ENEMY)
  assertEqual(ai.difficulty, 'normal', 'default difficulty')
  assertEqual(ai.personality, 'expander', 'default personality')
  assertEqual(ai.decisionTuning().attackArmy, 6, 'expander attacks a touch later than base 5')
})

test('attack threshold orders aggressor < expander < defender', () => {
  const a = tuning('normal', 'aggressor').attackArmy
  const e = tuning('normal', 'expander').attackArmy
  const d = tuning('normal', 'defender').attackArmy
  assert(a < e && e < d, `expected ${a} < ${e} < ${d}`)
})

test('aggressor never expands; expander expands earlier than base', () => {
  const a = tuning('normal', 'aggressor').expansionAtSec
  const e = tuning('normal', 'expander').expansionAtSec
  const d = tuning('normal', 'defender').expansionAtSec
  assert(a === Infinity, 'aggressor never builds a second hall')
  assert(e < 300, 'expander expands before the old 300s baseline')
  assert(d > 300, 'defender expands after the old baseline')
})

test('aggressor rushes economy-to-army faster than defender', () => {
  const a = tuning('normal', 'aggressor')
  const d = tuning('normal', 'defender')
  assert(a.workersBeforeArmy < d.workersBeforeArmy, 'aggressor builds barracks with fewer workers')
  assert(a.defenseRadius < d.defenseRadius, 'aggressor defends a smaller radius')
})

suite('ai-personality: behavior')

/** Reveal the player hall to the enemy AI and hand it `count` idle melee units. */
function armedScenario(count: number): { world: World; soldiers: number[] } {
  const world = makeWorld()
  let playerHallX = 0
  let playerHallZ = 0
  let enemyHallX = 0
  let enemyHallZ = 0
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
  // Enemy AI has scouted the player base.
  world.fog[TEAM_ENEMY].reveal(playerHallX, playerHallZ, 40)
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  return { world, soldiers }
}

function attackersOf(world: World, soldiers: number[]): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] === STATE_ATTACKMOVE) n += 1
  }
  return n
}

test('aggressor attacks with a small army', () => {
  const { world, soldiers } = armedScenario(5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 5, `aggressor should send all 5 soldiers, sent ${n}`)
})

test('defender holds back the same army', () => {
  const { world, soldiers } = armedScenario(6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 0, `defender should hold its 6 soldiers, sent ${n}`)
})

test('expander sits between the two', () => {
  const { world, soldiers } = armedScenario(5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 0, `expander with 5 soldiers should not attack yet (needs 6), sent ${n}`)
})

test('expander attacks once the army is big enough', () => {
  const { world, soldiers } = armedScenario(8)
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  const n = attackersOf(world, soldiers)
  assert(n >= 6, `expander should attack with 8 soldiers, sent ${n}`)
})
