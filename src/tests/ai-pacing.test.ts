/**
 * AI pacing tests — the opening advance delay (pacing slice L1-A,
 * 2026-10-27). The AI's first offensive wave may not launch before a
 * per-personality gameTime floor — aggressor 225s, defender 225s,
 * expander 240s (OPENING_ADVANCE_DELAY_SEC in ai/opponent.ts) — even
 * with the First Bell rung and a wave at full readiness. The gate sits
 * in attack() only: defense reactions are deliberately NOT gated.
 * Staging mirrors ai-personality.test.ts (bell rung, player hall
 * scouted, soldiers handed to the AI); the AI's clock is driven by the
 * dt passed to update(), exactly as the fixed-step loop drives it.
 * Headless and deterministic.
 */
import { World, KIND_HALL, KIND_SHRINE, STATE_ATTACK, STATE_ATTACKMOVE, TEAM_ENEMY, TEAM_PLAYER } from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

suite('ai-pacing: opening advance delay')

interface Armed {
  world: World
  soldiers: number[]
  enemyHallX: number
  enemyHallZ: number
  playerHallX: number
  playerHallZ: number
}

/**
 * Bell rung, player hall scouted, `count` idle enemy melee staged by
 * their hall. `holdShrine` marks the shrine as already AI-held so the
 * shrine-contest step cannot siphon staged soldiers into a sortie —
 * used when staging forces large enough to have a contest surplus.
 */
function armedScenario(count: number, holdShrine = false): Armed {
  const world = makeWorld()
  world.matchTime = 200
  world.bellsRung[0] = 1
  let playerHallX = 0
  let playerHallZ = 0
  let enemyHallX = 0
  let enemyHallZ = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE && holdShrine) world.shrineHeld[id] = TEAM_ENEMY
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
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  return { world, soldiers, enemyHallX, enemyHallZ, playerHallX, playerHallZ }
}

function attackersOf(world: World, soldiers: number[]): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] === STATE_ATTACKMOVE) n += 1
  }
  return n
}

function think(personality: AIPersonality, world: World, dt: number): void {
  new OpponentAI(TEAM_ENEMY, 'normal', personality).update(world, dt)
}

test('aggressor holds a ready wave before its 225s floor', () => {
  // 6 soldiers = the aggressor's full attack threshold: ready to march
  // the moment the gate opens, held only by the gate at 190s.
  const { world, soldiers } = armedScenario(6)
  think('aggressor', world, 190)
  assertEqual(attackersOf(world, soldiers), 0, 'no advance order before the floor')
})

test('defender holds a ready wave before its 225s floor', () => {
  // 13 soldiers: 13 - 4 garrison = 9 available = defender threshold.
  const { world, soldiers } = armedScenario(13, true)
  think('defender', world, 190)
  assertEqual(attackersOf(world, soldiers), 0, 'no advance order before the floor')
})

test('expander holds a ready wave at 230s — its floor is 240s, not 225s', () => {
  // 8 soldiers: 8 - 2 garrison = 6 available = expander threshold.
  // 230s is past the aggressor/defender floor, so a held wave here
  // pins the per-personality value, not a shared constant.
  const { world, soldiers } = armedScenario(8)
  think('expander', world, 230)
  assertEqual(attackersOf(world, soldiers), 0, 'expander still held at 230s')
})

test('aggressor gate is exact: held at 224s, marching at 225s', () => {
  const before = armedScenario(8)
  think('aggressor', before.world, 224)
  assertEqual(attackersOf(before.world, before.soldiers), 0, 'held one second before the floor')
  const at = armedScenario(8)
  think('aggressor', at.world, 225)
  const n = attackersOf(at.world, at.soldiers)
  assert(n >= 6, `wave launched at the floor (8 staged, 1 garrison), sent ${n}`)
})

test('defender advances once past its floor', () => {
  const { world, soldiers } = armedScenario(13, true)
  think('defender', world, 230)
  const n = attackersOf(world, soldiers)
  assert(n >= 8, `defender wave launched past the floor (13 staged, 4 garrison), sent ${n}`)
})

test('expander advances at its 240s floor', () => {
  const { world, soldiers } = armedScenario(8)
  think('expander', world, 240)
  const n = attackersOf(world, soldiers)
  assert(n >= 6, `expander wave launched at 240s (8 staged, 2 garrison), sent ${n}`)
})

test('defense is not gated: a raid is answered before the floor', () => {
  const { world, soldiers, enemyHallX, enemyHallZ } = armedScenario(6)
  // Two player raiders inside the AI's defense radius (aggressor: 18),
  // on the far side of the hall from the staged soldiers.
  const raiders = [
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 16, enemyHallZ).id,
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX - 16, enemyHallZ + 5).id,
  ]
  world.fog[TEAM_ENEMY].reveal(enemyHallX, enemyHallZ, 40)
  stepWorld(world, 5) // vision settles, as in the ai-personality raid rig
  think('aggressor', world, 190)
  // In this staging the combat system itself auto-engages the four
  // staged soldiers nearest the raiders during the settle (STATE_ATTACK
  // on the threat); defend()'s own contribution is the ATTACKMOVE it
  // issues to the rest. The claim under test: at 190s — 35s before the
  // advance floor — the full home guard is on the threat, nobody is
  // idle, and nobody marched on the player's base (the gated attack()
  // would have targeted it, 100+ units away; target proximity to a
  // raider is what proves which orders these are).
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
