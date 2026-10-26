/**
 * AI ranged-kiting tests.
 *
 * Combat's counter notes claim ranged units "kite melee effectively",
 * but no code ever did it: an engaged archer stood and traded against
 * a closing melee at 1.25x damage against it, on 85 HP vs the melee's
 * 170. microArmy now steps a ranged unit back when a visible enemy
 * melee gets within KITE_TRIGGER, to a point KITE_STANDOFF from that
 * melee — outside melee reach, inside its own weapon range — so it
 * re-engages from range once the move order completes. Headless and
 * deterministic.
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
 * Battlefield beyond the home-defense exemption, as in ai-micro.test.ts.
 * The AI's units attack-move as if the macro layer sent them; the enemy
 * melee is revealed to the AI through fog so canSee() counts it. The
 * enemy melee sits `meleeDx` along +x from the first own unit, so own
 * unit i starts |meleeDx - 2i| from it.
 */
function kiteScenario(
  personality: AIPersonality,
  ownKind: 'melee' | 'ranged',
  ownCount: number,
  meleeDx: number,
): { world: World; soldiers: number[]; melee: number; bx: number; bz: number } {
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const defenseRadius = new OpponentAI(TEAM_ENEMY, 'normal', personality)
    .decisionTuning().defenseRadius
  const d = defenseRadius + 10
  const bx = enemyHallX - d / Math.SQRT2
  const bz = enemyHallZ - d / Math.SQRT2
  const soldiers: number[] = []
  for (let i = 0; i < ownCount; i += 1) {
    const id = world.spawnUnit(ownKind, TEAM_ENEMY, bx + i * 2, bz).id
    soldiers.push(id)
    orderAttackMove(world, id, bx + 25, bz)
  }
  const melee = world.spawnUnit('melee', TEAM_PLAYER, bx + meleeDx, bz).id
  world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
  return { world, soldiers, melee, bx, bz }
}

function statesOf(world: World, soldiers: number[]): number[] {
  return soldiers.map((id) => world.state[id])
}

suite('ai-kiting: ranged step-back')

test('ranged units kite a closing melee instead of standing to trade', () => {
  const { world, soldiers, melee } = kiteScenario('defender', 'ranged', 2, 5)
  // 2 archers (170 HP) vs 1 melee (170 HP): below the defender's 1.35
  // retreat ratio, so no hall retreat — the kite step is what fires.
  const starts = soldiers.map((id) => ({
    x: world.positionX[id],
    z: world.positionZ[id],
  }))
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    [STATE_MOVE, STATE_MOVE].join(','),
    'both archers should step back from the closing melee',
  )
  for (let i = 0; i < soldiers.length; i += 1) {
    const id = soldiers[i]
    const mx = world.positionX[melee]
    const mz = world.positionZ[melee]
    const startD = Math.hypot(starts[i].x - mx, starts[i].z - mz)
    const targetD = Math.hypot(world.targetX[id] - mx, world.targetZ[id] - mz)
    assert(targetD > startD, `archer ${i} kite target must be farther from the melee`)
    assertEqual(targetD, 9, `archer ${i} kite target must sit at the 9-unit standoff`)
  }
})

test('melee units do not kite', () => {
  const { world, soldiers } = kiteScenario('defender', 'melee', 2, 5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    [STATE_ATTACKMOVE, STATE_ATTACKMOVE].join(','),
    'melee units should keep fighting, not step back',
  )
})

test('ranged units hold fire while the melee is still at range', () => {
  // Melee 10 and 8 away: inside the archers' 11 weapon range, outside
  // the 6-unit kite trigger — no step back.
  const { world, soldiers } = kiteScenario('defender', 'ranged', 2, 10)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    [STATE_ATTACKMOVE, STATE_ATTACKMOVE].join(','),
    'archers at safe distance should keep shooting',
  )
})

test('home defense holds the line regardless of the kite trigger', () => {
  // One archer attack-moving inside its own hall's defense radius,
  // with an enemy melee 3 away: the home exemption covers kiting too.
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const id = world.spawnUnit('ranged', TEAM_ENEMY, enemyHallX + 5, enemyHallZ).id
  orderAttackMove(world, id, enemyHallX + 10, enemyHallZ)
  world.spawnUnit('melee', TEAM_PLAYER, enemyHallX + 8, enemyHallZ)
  world.fog[TEAM_ENEMY].reveal(enemyHallX + 8, enemyHallZ, 30)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.state[id], STATE_ATTACKMOVE, 'home defenders never kite')
})

test('kiting is deterministic', () => {
  const a = kiteScenario('defender', 'ranged', 2, 5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(a.world, 5)
  const b = kiteScenario('defender', 'ranged', 2, 5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(b.world, 5)
  assertEqual(
    statesOf(a.world, a.soldiers).join(','),
    statesOf(b.world, b.soldiers).join(','),
    'identical skirmishes must reach identical kite decisions',
  )
  assertEqual(
    a.soldiers.map((id) => `${a.world.targetX[id]},${a.world.targetZ[id]}`).join(';'),
    b.soldiers.map((id) => `${b.world.targetX[id]},${b.world.targetZ[id]}`).join(';'),
    'identical skirmishes must pick identical kite destinations',
  )
})

suite('ai-kiting: always-be-shooting skips (War Horn slice R5)')

/**
 * One defender archer facing a closing melee (the kite threat, 5 away,
 * health set to `threatFrac` of max) plus a second melee 12 away at 40%
 * health. The second melee's health keeps the local sums in the band
 * where neither the retreat (foe > own x 1.35) nor the cluster-won skip
 * (own >= foe x 1.35) can fire — so the ONLY thing that can stop the
 * kite step is the threat's own dying band.
 * own = 85; foe = 170 x threatFrac + 68: at 25% foe = 110.5, at 26%
 * foe = 112.2 — both below the 114.75 retreat line, both far above the
 * cluster-won line.
 */
function dyingBandScenario(threatFrac: number): { world: World; archer: number; threat: number } {
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const defenseRadius = new OpponentAI(TEAM_ENEMY, 'normal', 'defender')
    .decisionTuning().defenseRadius
  const d = defenseRadius + 10
  const bx = enemyHallX - d / Math.SQRT2
  const bz = enemyHallZ - d / Math.SQRT2
  const archer = world.spawnUnit('ranged', TEAM_ENEMY, bx, bz).id
  orderAttackMove(world, archer, bx + 25, bz)
  const threat = world.spawnUnit('melee', TEAM_PLAYER, bx + 5, bz).id
  world.health[threat] = world.maxHealth[threat] * threatFrac
  const bulk = world.spawnUnit('melee', TEAM_PLAYER, bx + 12, bz).id
  world.health[bulk] = world.maxHealth[bulk] * 0.4
  world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
  return { world, archer, threat }
}

test('ranged holds and shoots when the closing melee is dying (<=25% HP)', () => {
  const { world, archer } = dyingBandScenario(0.25)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    world.state[archer],
    STATE_ATTACKMOVE,
    'the archer keeps shooting instead of stepping back from a dying melee',
  )
})

test('ranged still kites a closing melee just above the dying band (26% HP)', () => {
  const { world, archer, threat } = dyingBandScenario(0.26)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.state[archer], STATE_MOVE, 'a melee that can still arrive earns the step back')
  const targetD = Math.hypot(
    world.targetX[archer] - world.positionX[threat],
    world.targetZ[archer] - world.positionZ[threat],
  )
  assertEqual(targetD, 9, 'the kite destination sits at the 9-unit standoff')
})

test('ranged holds when the local cluster is already won decisively', () => {
  // 3 archers (255 HP of local strength) vs 1 full-health melee (170):
  // own sum >= foe sum x the defender's 1.35 retreat ratio — the
  // cluster is won, so the threatened archer's arrows outvalue its feet.
  const { world, soldiers } = kiteScenario('defender', 'ranged', 3, 5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(
    statesOf(world, soldiers).join(','),
    [STATE_ATTACKMOVE, STATE_ATTACKMOVE, STATE_ATTACKMOVE].join(','),
    'no archer steps back from a cluster it is already winning',
  )
})
