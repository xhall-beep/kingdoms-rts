/**
 * AI battle-micro tests — tactical retreat and wounded withdrawal.
 *
 * The AI's armies used to fight to the last unit: an attack wave that ran
 * into a superior visible force died in place instead of pulling back.
 * microArmy() runs each think tick: engaged soldiers (away from the home
 * defense radius) compare local health-weighted strength and retreat to the
 * hall when outmatched, and badly wounded soldiers withdraw to recover.
 * Headless and deterministic.
 */
import {
  KIND_HALL,
  STATE_ATTACKMOVE,
  STATE_MOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
  type World,
} from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { orderAttackMove } from '../systems/combat.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'

/** Mid-game scenario: First Bell has rung so the AI's macro layer is live. */
function midGameWorld(): { world: World; enemyHallX: number; enemyHallZ: number } {
  const world = makeWorld()
  world.matchTime = 200
  world.bellsRung[0] = 1
  let enemyHallX = 0
  let enemyHallZ = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_ENEMY) {
      enemyHallX = world.positionX[id]
      enemyHallZ = world.positionZ[id]
    }
  }
  return { world, enemyHallX, enemyHallZ }
}

/**
 * Battlefield clearly beyond the home-defense exemption (defense radius +
 * 10), placed on the diagonal toward mid-map so it stays on the playable
 * area. The AI's soldiers are attack-moving as if the macro layer sent them;
 * the enemy force is revealed to the AI through fog so canSee() counts it.
 */
function battleScenario(
  personality: AIPersonality,
  ownCount: number,
  enemyCount: number,
  woundedFractions: number[] = [],
): { world: World; soldiers: number[] } {
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const defenseRadius = new OpponentAI(TEAM_ENEMY, 'normal', personality)
    .decisionTuning().defenseRadius
  const d = defenseRadius + 10
  const bx = enemyHallX - d / Math.SQRT2
  const bz = enemyHallZ - d / Math.SQRT2
  const soldiers: number[] = []
  for (let i = 0; i < ownCount; i += 1) {
    const id = world.spawnUnit('melee', TEAM_ENEMY, bx + i * 2, bz).id
    soldiers.push(id)
    orderAttackMove(world, id, bx + 25, bz)
    if (woundedFractions[i] !== undefined) {
      world.health[id] = world.maxHealth[id] * woundedFractions[i]
    }
  }
  for (let i = 0; i < enemyCount; i += 1) {
    world.spawnUnit('melee', TEAM_PLAYER, bx - i * 2, bz + 3)
  }
  world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
  return { world, soldiers }
}

function statesOf(world: World, soldiers: number[]): number[] {
  return soldiers.map((id) => world.state[id])
}

suite('ai-micro: tactical retreat')

test('outnumbered attackers pull back to the hall', () => {
  const { world, soldiers } = battleScenario('defender', 2, 6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    [STATE_MOVE, STATE_MOVE].join(','),
    'both outnumbered soldiers should retreat',
  )
})

test('a superior force stands its ground', () => {
  const { world, soldiers } = battleScenario('defender', 6, 1)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    new Array(6).fill(STATE_ATTACKMOVE).join(','),
    'the stronger side should keep attacking',
  )
})

test('personality bends the retreat threshold: aggressor fights on', () => {
  // 2 vs 4: outnumbered 2:1. The defender (ratio 1.35) retreats; the
  // aggressor (ratio 3.0) fights on.
  const d = battleScenario('defender', 2, 4)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(d.world, 5)
  const a = battleScenario('aggressor', 2, 4)
  new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(a.world, 5)
  assert(
    statesOf(d.world, d.soldiers).every((s) => s === STATE_MOVE),
    'defender should retreat at 2:1 odds',
  )
  assert(
    statesOf(a.world, a.soldiers).every((s) => s === STATE_ATTACKMOVE),
    'aggressor should fight on at 2:1 odds',
  )
})

test('home defense holds the line regardless of the odds', () => {
  // One soldier attack-moving *inside* the defense radius of its own hall,
  // facing 6 visible enemies: the exemption keeps it fighting.
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const id = world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5, enemyHallZ).id
  orderAttackMove(world, id, enemyHallX + 10, enemyHallZ)
  for (let i = 0; i < 6; i += 1) {
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX + 8 + i, enemyHallZ + 2)
  }
  world.fog[TEAM_ENEMY].reveal(enemyHallX + 8, enemyHallZ, 30)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.state[id], STATE_ATTACKMOVE, 'home defenders never retreat')
})

test('retreat is deterministic', () => {
  const a = battleScenario('defender', 2, 6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(a.world, 5)
  const b = battleScenario('defender', 2, 6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(b.world, 5)
  assertEqual(
    statesOf(a.world, a.soldiers).join(','),
    statesOf(b.world, b.soldiers).join(','),
    'identical battles must reach identical micro decisions',
  )
})

suite('ai-micro: wounded withdrawal')

test('a badly wounded soldier withdraws to the hall', () => {
  // One soldier at 20% HP, no enemies nearby: withdrawal, not retreat.
  const { world, soldiers } = battleScenario('expander', 1, 0, [0.2])
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.state[soldiers[0]], STATE_MOVE, 'wounded soldier should withdraw')
})

test('a healthy soldier does not withdraw alone', () => {
  const { world, soldiers } = battleScenario('expander', 1, 0)
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.state[soldiers[0]], STATE_ATTACKMOVE, 'healthy soldier keeps attacking')
})

test('the aggressor never withdraws wounded', () => {
  const { world, soldiers } = battleScenario('aggressor', 1, 0, [0.2])
  new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(world, 5)
  assertEqual(
    world.state[soldiers[0]],
    STATE_ATTACKMOVE,
    'aggressor holds the line while it still stands',
  )
})
