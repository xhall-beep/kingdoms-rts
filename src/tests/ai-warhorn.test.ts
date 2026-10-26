/**
 * AI War Horn tests (War Horn slice, 2026-10-26).
 *
 * The horn was a player-only instrument: charge accrues from damage
 * dealt, but no AI code ever spent it — the systems audit's 12-minute
 * AI-vs-AI probe measured rallyEver = [false, false], both AIs sitting
 * at the 100 cap while Coward's Decay deleted the meter. OpponentAI
 * now runs soundWarHornStep after the defend/attack dispatch: the rally
 * is picked by the fight's shape (Second Wind for the bleed, Ironblood
 * for the clash, Gale March for the approach), gated by a per-
 * personality HORN_PROFILE, with an anti-decay conversion for a meter
 * about to be wiped while a wave is marching. These tests pin every
 * gate headlessly, in the ai-kiting scenario style: one think, crafted
 * states, fog revealed so canSee() counts the enemy.
 */
import {
  KIND_HALL,
  KIND_SHRINE,
  KIND_WORKER,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
  type World,
} from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { orderAttackMove } from '../systems/combat.ts'
import { RALLY_GALE, RALLY_IRONBLOOD } from '../systems/warhorn.ts'
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import { makeWorld, STEP, stepWorld } from './setup.ts'

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

/** A battlefield beyond the AI hall's defense radius (kiting-test geometry). */
function battlefield(
  personality: AIPersonality,
): { world: World; bx: number; bz: number } {
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  const defenseRadius = new OpponentAI(TEAM_ENEMY, 'normal', personality)
    .decisionTuning().defenseRadius
  const d = defenseRadius + 10
  const bx = enemyHallX - d / Math.SQRT2
  const bz = enemyHallZ - d / Math.SQRT2
  return { world, bx, bz }
}

/** Spawn `count` own melee in STATE_ATTACK at the battlefield, at `hpFrac` health. */
function engagedArmy(
  world: World,
  bx: number,
  bz: number,
  count: number,
  hpFrac: number,
): number[] {
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    const id = world.spawnUnit('melee', TEAM_ENEMY, bx + i * 2, bz).id
    world.state[id] = STATE_ATTACK
    world.health[id] = world.maxHealth[id] * hpFrac
    soldiers.push(id)
  }
  return soldiers
}

/** Spawn `count` full-health enemy melee inside the cluster and reveal them. */
function foesInCluster(world: World, bx: number, bz: number, count: number): number[] {
  const foes: number[] = []
  for (let i = 0; i < count; i += 1) {
    foes.push(world.spawnUnit('melee', TEAM_PLAYER, bx + 1 + i * 2, bz + 3).id)
  }
  world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
  return foes
}

suite('ai-warhorn: rally choice by fight shape')

test('Second Wind fires when the engaged army is bleeding', () => {
  const { world, bx, bz } = battlefield('expander')
  const soldiers = engagedArmy(world, bx, bz, 4, 0.5)
  foesInCluster(world, bx, bz, 4)
  world.warCharge[TEAM_ENEMY] = 100
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.warCharge[TEAM_ENEMY], 50, 'the sounding costs 50 charge')
  assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'Second Wind sets no buff rally')
  for (const id of soldiers) {
    assertClose(
      world.health[id],
      world.maxHealth[id] * 0.8,
      0.05,
      'each engaged soldier healed 30% of max (0.5 -> 0.8)',
    )
  }
})

test('the charge floor blocks firing: 49 charge never sounds', () => {
  const { world, bx, bz } = battlefield('expander')
  const soldiers = engagedArmy(world, bx, bz, 4, 0.5)
  foesInCluster(world, bx, bz, 4)
  world.warCharge[TEAM_ENEMY] = 49
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.warCharge[TEAM_ENEMY], 49, 'charge untouched below the cost')
  assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'no rally')
  for (const id of soldiers) {
    assertClose(world.health[id], world.maxHealth[id] * 0.5, 0.05, 'no heal landed')
  }
})

test('Ironblood fires in a real clash at full health', () => {
  const { world, bx, bz } = battlefield('expander')
  engagedArmy(world, bx, bz, 4, 1.0)
  foesInCluster(world, bx, bz, 4) // foe sum equals own sum — a real fight, not a mop-up
  world.warCharge[TEAM_ENEMY] = 100
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.rallyKind[TEAM_ENEMY], RALLY_IRONBLOOD, 'Ironblood is sounding')
  assertEqual(world.rallyUntil[TEAM_ENEMY], world.matchTime + 20, 'the rally runs 20 s')
  assertEqual(world.warCharge[TEAM_ENEMY], 50, 'the sounding costs 50 charge')
})

test('Gale March fires on the approach — a wave marching, no contact yet', () => {
  const { world, bx, bz } = battlefield('expander')
  for (let i = 0; i < 3; i += 1) {
    const id = world.spawnUnit('melee', TEAM_ENEMY, bx + i * 2, bz).id
    orderAttackMove(world, id, bx + 25, bz)
  }
  world.warCharge[TEAM_ENEMY] = 100
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  assertEqual(world.rallyKind[TEAM_ENEMY], RALLY_GALE, 'Gale March speeds the approach')
  assertEqual(world.warCharge[TEAM_ENEMY], 50, 'the sounding costs 50 charge')
})

test('lockstep mode emits the warhorn command instead of mutating', () => {
  const { world, bx, bz } = battlefield('expander')
  const soldiers = engagedArmy(world, bx, bz, 4, 0.5)
  foesInCluster(world, bx, bz, 4)
  world.warCharge[TEAM_ENEMY] = 100
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  const cmds: unknown[] = []
  ai.setCommandSink((cmd) => cmds.push(cmd))
  ai.update(world, 5)
  const horns = cmds.filter(
    (c) => (c as { type: string }).type === 'warhorn',
  ) as { type: 'warhorn'; team: 0 | 1; rally: 1 | 2 | 3 }[]
  assertEqual(horns.length, 1, 'exactly one warhorn command emitted')
  assertEqual(horns[0].team, TEAM_ENEMY, 'the command carries the AI team')
  assertEqual(horns[0].rally, 3, 'the command carries Second Wind')
  assertEqual(world.warCharge[TEAM_ENEMY], 100, 'sink mode does not spend charge locally')
  for (const id of soldiers) {
    assertClose(world.health[id], world.maxHealth[id] * 0.5, 0.05, 'sink mode does not heal locally')
  }
})

suite('ai-warhorn: personality profiles')

test('Wind window differs by personality: at 62% the defender heals, the aggressor holds', () => {
  // Defender (windHp 0.70): the same bleed is inside its window.
  {
    const { world, bx, bz } = battlefield('defender')
    const soldiers = engagedArmy(world, bx, bz, 5, 0.62)
    // One dying foe keeps the cluster "engaged" without making an
    // Ironblood clash (foe sum far below half the own sum).
    const foe = world.spawnUnit('melee', TEAM_PLAYER, bx + 1, bz + 3).id
    world.health[foe] = 20
    world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
    world.warCharge[TEAM_ENEMY] = 100
    new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
    assertEqual(world.warCharge[TEAM_ENEMY], 50, 'defender sounded Second Wind')
    for (const id of soldiers) {
      assertClose(world.health[id], world.maxHealth[id] * 0.92, 0.05, 'healed 0.62 -> 0.92')
    }
  }
  // Aggressor (windHp 0.55): 62% is not bleeding enough — it holds.
  {
    const { world, bx, bz } = battlefield('aggressor')
    const soldiers = engagedArmy(world, bx, bz, 5, 0.62)
    const foe = world.spawnUnit('melee', TEAM_PLAYER, bx + 1, bz + 3).id
    world.health[foe] = 20
    world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
    world.warCharge[TEAM_ENEMY] = 100
    new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(world, 5)
    assertEqual(world.warCharge[TEAM_ENEMY], 100, 'aggressor holds below its Wind window')
    assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'no rally')
    for (const id of soldiers) {
      assertClose(world.health[id], world.maxHealth[id] * 0.62, 0.05, 'no heal landed')
    }
  }
})

test('the defender spends offensively only on a full meter', () => {
  const { world, bx, bz } = battlefield('defender')
  const soldiers = engagedArmy(world, bx, bz, 5, 0.62)
  const foe = world.spawnUnit('melee', TEAM_PLAYER, bx + 1, bz + 3).id
  world.health[foe] = 20
  world.fog[TEAM_ENEMY].reveal(bx, bz, 30)
  world.warCharge[TEAM_ENEMY] = 75 // a Wind-worthy bleed, but below the offensive floor
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.warCharge[TEAM_ENEMY], 75, 'no offensive spend below 100 charge')
  assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'no rally')
  for (const id of soldiers) {
    assertClose(world.health[id], world.maxHealth[id] * 0.62, 0.05, 'no heal landed')
  }
})

test('defender defensive Wind counts the workers and fires at 50', () => {
  // The fight is at the defender's own hall: two enemy melee inside the
  // defense radius, the seeded workers hurt. No own soldiers exist, so
  // only the defensive track — which counts the workers — can answer.
  const setup = (): { world: World; workers: number[] } => {
    const { world, enemyHallX, enemyHallZ } = midGameWorld()
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX + 6, enemyHallZ)
    world.spawnUnit('melee', TEAM_PLAYER, enemyHallX + 8, enemyHallZ + 2)
    world.fog[TEAM_ENEMY].reveal(enemyHallX, enemyHallZ, 45)
    const workers: number[] = []
    for (const id of world.entities.keys()) {
      if (world.team[id] === TEAM_ENEMY && world.kind[id] === KIND_WORKER) {
        world.health[id] = world.maxHealth[id] * 0.4
        workers.push(id)
      }
    }
    world.warCharge[TEAM_ENEMY] = 50
    // One stepped tick: the spatial hash defend() reads rebuilds at the
    // top of world.update — the same order the live game thinks in.
    stepWorld(world, 1)
    return { world, workers }
  }
  {
    const { world, workers } = setup()
    assert(workers.length >= 4, 'the scenario seeds at least four workers')
    const before = new Map(workers.map((id) => [id, world.health[id]]))
    new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
    assertEqual(world.warCharge[TEAM_ENEMY], 0, 'defensive Wind sounded at 50 charge')
    for (const id of workers) {
      const want = Math.min(world.maxHealth[id], before.get(id)! + world.maxHealth[id] * 0.3)
      assertClose(world.health[id], want, 0.05, 'each worker healed 30% of max')
    }
  }
  // Control: the expander has no defensive track — the same home fight
  // at 50 charge sounds nothing (no engaged soldiers, no advancing wave).
  {
    const { world, workers } = setup()
    const before = new Map(workers.map((id) => [id, world.health[id]]))
    new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
    assertEqual(world.warCharge[TEAM_ENEMY], 50, 'expander holds at home')
    for (const id of workers) {
      assertClose(world.health[id], before.get(id)!, 0.05, 'no heal landed')
    }
  }
})

suite('ai-warhorn: anti-decay conversion')

/** A defender with an advancing wave beyond its defense radius. */
function advancingWaveWorld(): { world: World } {
  const { world, bx, bz } = battlefield('defender')
  for (let i = 0; i < 3; i += 1) {
    const id = world.spawnUnit('melee', TEAM_ENEMY, bx + i * 2, bz).id
    orderAttackMove(world, id, bx + 25, bz)
  }
  return { world }
}

test('a meter ~15 s from deletion converts to Gale while a wave marches', () => {
  const { world } = advancingWaveWorld()
  world.warCharge[TEAM_ENEMY] = 75 // below the defender's offensive floor of 100
  world.warLastTick[TEAM_ENEMY] = world.tick - 30 * 60 // 30 s of peace; decay wipes at 45 s
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.rallyKind[TEAM_ENEMY], RALLY_GALE, 'the dying meter became approach speed')
  assertEqual(world.warCharge[TEAM_ENEMY], 25, 'the conversion costs 50 charge')
})

test('anti-decay veto: the army home and idle keeps its meter', () => {
  const { world, enemyHallX, enemyHallZ } = midGameWorld()
  for (let i = 0; i < 3; i += 1) {
    world.spawnUnit('melee', TEAM_ENEMY, enemyHallX - 4 + i * 2, enemyHallZ - 4)
  }
  world.warCharge[TEAM_ENEMY] = 75
  world.warLastTick[TEAM_ENEMY] = world.tick - 30 * 60
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'no firing into emptiness at home')
  assertEqual(world.warCharge[TEAM_ENEMY], 75, 'the meter is kept (decay is free at home)')
})

test('anti-decay is not armed early: 10 s of peace converts nothing', () => {
  const { world } = advancingWaveWorld()
  world.warCharge[TEAM_ENEMY] = 75
  world.warLastTick[TEAM_ENEMY] = world.tick - 10 * 60 // decay is still 35 s away
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  assertEqual(world.rallyKind[TEAM_ENEMY], 0, 'no conversion outside the decay window')
  assertEqual(world.warCharge[TEAM_ENEMY], 75, 'charge untouched')
})

suite('ai-warhorn: shrine coupling')

test('the expander sounds Gale for the shrine emergency sortie', () => {
  const world = makeWorld()
  world.matchTime = 200
  world.bellsRung[0] = 1
  let shrine = -1
  let sx = 0
  let sz = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) {
      shrine = id
      sx = world.positionX[id]
      sz = world.positionZ[id]
    }
  }
  assert(shrine !== -1, 'scenario shrine exists')
  // The enemy holds the point with a living unit: the VP drain is live.
  world.shrineHeld[shrine] = TEAM_PLAYER
  world.spawnUnit('melee', TEAM_PLAYER, sx + 2, sz)
  // Five idle soldiers at home — a genuine surplus beyond the garrison.
  const soldiers: number[] = []
  for (const [x, z] of [[34, 34], [36, 34], [34, 36], [36, 36], [32, 34]] as const) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, x, z).id)
  }
  world.warCharge[TEAM_ENEMY] = 100
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  const marching = soldiers.filter((id) => world.state[id] === STATE_ATTACKMOVE)
  assertEqual(marching.length, 3, 'the emergency sortie was dispatched (test is not vacuous)')
  assertEqual(world.rallyKind[TEAM_ENEMY], RALLY_GALE, 'Gale March speeds the sortie')
  assertEqual(world.warCharge[TEAM_ENEMY], 50, 'the sounding costs 50 charge')
})

suite('ai-warhorn: AI-vs-AI probe')

test('two AIs fighting a real match sound the horn (the audit probe, inverted)', () => {
  const world = makeWorld()
  world.registerSystem(new OpponentAI(0, 'normal', 'expander'))
  world.registerSystem(new OpponentAI(1, 'normal', 'aggressor'))
  // Detection across each tick boundary: a buff rally appears as a
  // rallyKind 0 -> nonzero transition; Second Wind sets no rallyKind,
  // so it appears as a >= 30 charge drop in a tick where Coward's Decay
  // cannot be the cause (decay needs tick - warLastTick > 2700).
  let prevKind = [world.rallyKind[0], world.rallyKind[1]]
  let prevCharge = [world.warCharge[0], world.warCharge[1]]
  const fires: { team: number; rally: number; at: number }[] = []
  const cap = 60 * 60 * 8 // 8 sim-minutes — the audit's silence ran 12
  let step = 0
  while (world.winner === -1 && step < cap && fires.length === 0) {
    world.update(STEP)
    step += 1
    for (const t of [0, 1] as const) {
      if (prevKind[t] === 0 && world.rallyKind[t] !== 0) {
        fires.push({ team: t, rally: world.rallyKind[t], at: world.matchTime })
      } else if (
        world.rallyKind[t] === 0 &&
        prevCharge[t] - world.warCharge[t] >= 30 &&
        world.tick - world.warLastTick[t] <= 2700
      ) {
        fires.push({ team: t, rally: 3, at: world.matchTime })
      }
      prevKind[t] = world.rallyKind[t]
      prevCharge[t] = world.warCharge[t]
    }
  }
  assert(
    fires.length >= 1,
    `at least one rally must sound within 8 sim-minutes (winner=${world.winner}, steps=${step})`,
  )
  const first = fires[0]
  console.log(
    `  probe evidence: first rally at ${first.at.toFixed(1)}s sim — team ${first.team} ` +
      `(${first.team === 0 ? 'expander/human' : 'aggressor/orc'}) sounded rally ${first.rally} ` +
      `(1=Gale March, 2=Ironblood, 3=Second Wind)`,
  )
  assert(first.rally >= 1 && first.rally <= 3, 'the fired rally is a real rally kind')
})
