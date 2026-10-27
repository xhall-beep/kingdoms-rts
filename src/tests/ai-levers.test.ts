/**
 * AI levers regression tests (orc-human audit 2026-10-22).
 *
 * The audit's binding finding: orc's advantages are automatic (stat mods,
 * carry capacity, plunder), while human's designed counters were opt-in
 * actions the AI never took — the Militia Bell was never rung and the
 * whole research ladder was dark for the AI (researchUpgrade was only
 * called from the player UI). And orc's designed gather offset
 * (mods.gather 0.9, the counterweight to carry-20) had no consumer
 * anywhere in the sim. Pinned here:
 *  - The AI rings the Militia Bell in a scripted home defense (human),
 *    never for non-human factions, and not for a lone worker scout.
 *  - In lockstep sink mode the bell is emitted as a 'militia' command.
 *  - The AI researches: levels rise by mid-game when the bank allows;
 *    the gate floors on the picked ladder's own faction-priced cost
 *    (100g, human 80g via Adaptable) with a flat 3-soldier army
 *    precondition — the old 400g surplus floor sampled a bank the AI
 *    economy never holds and research fired ~never (bank-dynamics
 *    audit 2026-10-22); in sink mode research applies directly, like
 *    the AI's orc tier upgrades.
 *  - Mustered militia are exempt from worker evacuation: the AI used
 *    to re-order its own pikemen behind the hall every think, walking
 *    the muster off its stand (bank-dynamics audit ring census).
 *  - The gather swing cycle scales by mods.gather: orc/undead (0.9)
 *    swing slower than human/elf (1.0), by the designed ratio.
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_WORKER,
  KIND_HALL,
  KIND_GOLDMINE,
  STATE_GATHER,
  STATE_MOVE,
  STATE_ATTACK,
} from '../core/World.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { OpponentAI } from '../ai/opponent.ts'
import type { Command } from '../session/commands.ts'
import { seedScenario } from '../scenario.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('ai levers: militia bell, research, gather modifier')

/** Production-faithful world (composeGame order) with one AI on team 0. */
function makeAiWorld(playerFaction: string, enemyFaction: string, withAi = true): World {
  const world = new World()
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new BellSystemImpl())
  world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new WarHornSystemImpl())
  world.registerSystem(new ShrineSystemImpl())
  if (withAi) world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'expander'))
  world.registerSystem(new MovementSystemImpl())
  seedScenario(world, playerFaction as never, enemyFaction as never)
  return world
}

function countMilitia(world: World, team: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_WORKER && world.isMilitia(id)) n += 1
  }
  return n
}

test('AI rings the Militia Bell in a human home defense', () => {
  const world = makeAiWorld('human', 'orc')
  // An orc raider inside the defense radius of the human hall (-40,-40).
  world.spawnUnit('melee', TEAM_ENEMY, -24, -40)
  stepWorld(world, 180) // 3 simulated seconds: vision settles, AI thinks.
  assert(world.militiaCooldown[TEAM_PLAYER] > 0, 'the bell was rung (cooldown running)')
  assert(countMilitia(world, TEAM_PLAYER) > 0, 'peasants mustered as militia')
})

test('AI never rings the bell for a non-human faction', () => {
  const world = makeAiWorld('orc', 'human')
  // A human raider inside the defense radius of the orc hall (40,40).
  world.spawnUnit('melee', TEAM_ENEMY, 24, 40)
  stepWorld(world, 180)
  assertEqual(world.militiaCooldown[TEAM_PLAYER], 0, 'orcs have no bell to ring')
  assertEqual(countMilitia(world, TEAM_PLAYER), 0, 'no orc militia')
})

test('a lone enemy worker scout does not spend the bell', () => {
  const world = makeAiWorld('human', 'orc')
  world.spawnUnit('worker', TEAM_ENEMY, -26, -40)
  stepWorld(world, 180)
  assertEqual(world.militiaCooldown[TEAM_PLAYER], 0, 'worker presence alone never rings')
})

test('in sink mode the bell is emitted as a militia command', () => {
  const world = makeAiWorld('human', 'orc', false)
  world.spawnUnit('melee', TEAM_ENEMY, -24, -40)
  stepWorld(world, 30) // Let vision settle without an AI driving.
  const ai = new OpponentAI(TEAM_PLAYER, 'normal', 'expander')
  const emitted: Command[] = []
  ai.setCommandSink((cmd) => emitted.push(cmd))
  ai.update(world, 1.0) // One think tick.
  const bell = emitted.filter((c) => c.type === 'militia')
  assertEqual(bell.length, 1, 'exactly one militia command emitted')
  assertEqual(world.militiaCooldown[TEAM_PLAYER], 0, 'sink mode does not mutate the world directly')
})

test('mustered militia hold their stand instead of being evacuated', () => {
  const world = makeAiWorld('human', 'orc')
  stepWorld(world, 60 * 75) // Economy up: the worker line is out on the resources.
  // Drop a raid wave on the gold mine the line is working.
  let hall = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_HALL) {
      hall = id
      break
    }
  }
  let mine = -1
  let best = Infinity
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_GOLDMINE) continue
    const d = Math.hypot(
      world.positionX[id] - world.positionX[hall],
      world.positionZ[id] - world.positionZ[hall],
    )
    if (d < best) {
      best = d
      mine = id
    }
  }
  const mx = world.positionX[mine]
  const mz = world.positionZ[mine]
  for (let i = 0; i < 5; i += 1) world.spawnUnit('melee', TEAM_ENEMY, mx + (i - 2) * 1.5, mz + 2)
  // Census every step for 6s after the ring (the audit's method):
  // pre-fix, evacuateWorkers re-ordered the muster behind the hall every
  // think and ~half the pikemen sat in STATE_MOVE at +5s; the exemption
  // must leave the stand fighting, never walking.
  let ringAt = -1
  let muster = 0
  let moveSightings = 0
  let attackSightings = 0
  for (let s = 0; s < 60 * 30 && (ringAt < 0 || world.matchTime - ringAt < 6); s += 1) {
    stepWorld(world, 1)
    if (ringAt < 0) {
      if (world.militiaCooldown[TEAM_PLAYER] > 0) {
        ringAt = world.matchTime
        muster = countMilitia(world, TEAM_PLAYER)
      }
      continue
    }
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_PLAYER || world.kind[id] !== KIND_WORKER) continue
      if (!world.isMilitia(id)) continue
      if (world.state[id] === STATE_MOVE) moveSightings += 1
      if (world.state[id] === STATE_ATTACK) attackSightings += 1
    }
  }
  assert(ringAt > 0, 'the bell rang for the mine raid')
  assert(muster >= 4, `a real muster took the stand (${muster} pikemen)`)
  assert(attackSightings > 0, 'the muster engaged the raiders')
  assertEqual(moveSightings, 0, 'no mustered pikeman was evacuated off its stand')
})

test('AI researches once its bank clears the floor', () => {
  const world = makeAiWorld('human', 'orc')
  world.spawnBuilding('barracks', TEAM_PLAYER, -34, -46, true)
  world.spawnBuilding('archery', TEAM_PLAYER, -46, -34, true)
  world.spawnBuilding('smithy', TEAM_PLAYER, -40, -54, true)
  // A standing army past the research precondition: research upgrades
  // the army you have — the step stands down while the army is forming.
  for (let i = 0; i < 8; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  world.gold[TEAM_PLAYER] = 5000
  world.wood[TEAM_PLAYER] = 2000
  stepWorld(world, 600) // 10 simulated seconds.
  assert(world.meleeDmgLvl[TEAM_PLAYER] >= 1, 'melee damage researched by mid-game')
  // Purchases are paced (RESEARCH_PACE): the ladder climbs in mid-game
  // beats, not in one sprint — a second level lands after the pace.
  stepWorld(world, 60 * 140)
  const total =
    world.meleeDmgLvl[TEAM_PLAYER] + world.meleeHpLvl[TEAM_PLAYER] + world.rangedDmgLvl[TEAM_PLAYER]
  assert(total >= 2, `the ladder keeps climbing at its pace (total levels ${total})`)
})

/**
 * One think tick of a fresh AI on a staged world, with the hall's
 * training slot faked busy so trainWorkers cannot spend the staged
 * bank before the research step sees it — the research gate is then
 * the only thing that can move the ladder.
 */
function oneThink(world: World): void {
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_HALL) {
      world.trainKind[id] = KIND_WORKER // Any non-idle marker: slot busy.
    }
  }
  const ai = new OpponentAI(TEAM_PLAYER, 'normal', 'expander')
  ai.update(world, 1.0)
}

function totalLevels(world: World, team: number): number {
  return world.meleeDmgLvl[team] + world.meleeHpLvl[team] + world.rangedDmgLvl[team]
}

test('research gate: no fire below the faction-priced ladder cost', () => {
  // Human pays 80g via Adaptable: 79g in the bank must not fire.
  const human = makeAiWorld('human', 'orc', false)
  human.spawnBuilding('smithy', TEAM_PLAYER, -34, -46, true)
  for (let i = 0; i < 8; i += 1) human.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  human.gold[TEAM_PLAYER] = 79
  human.wood[TEAM_PLAYER] = 500
  oneThink(human)
  assertEqual(totalLevels(human, TEAM_PLAYER), 0, 'human: no research at 79g (below its 80g price)')
  // Elf pays the full 100g: 99g must not fire.
  const elf = makeAiWorld('elf', 'orc', false)
  elf.spawnBuilding('smithy', TEAM_PLAYER, -34, -46, true)
  for (let i = 0; i < 8; i += 1) elf.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  elf.gold[TEAM_PLAYER] = 99
  elf.wood[TEAM_PLAYER] = 500
  oneThink(elf)
  assertEqual(totalLevels(elf, TEAM_PLAYER), 0, 'elf: no research at 99g (below the 100g price)')
})

test('research gate: human fires at exactly its discounted cost with 3 soldiers', () => {
  const world = makeAiWorld('human', 'orc', false)
  world.spawnBuilding('smithy', TEAM_PLAYER, -34, -46, true)
  // Exactly the flat army precondition — no more.
  for (let i = 0; i < 3; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  world.gold[TEAM_PLAYER] = 80 // Adaptable price of meleeDmg 1: 100 x 0.8.
  world.wood[TEAM_PLAYER] = 40 // 50 x 0.8.
  oneThink(world)
  assertEqual(world.meleeDmgLvl[TEAM_PLAYER], 1, 'the level landed at the discounted price')
  assertEqual(world.gold[TEAM_PLAYER], 0, 'exactly the discounted gold price was charged')
  assertEqual(world.wood[TEAM_PLAYER], 0, 'exactly the discounted wood price was charged')
})

test('research gate: no fire below 3 standing soldiers', () => {
  const world = makeAiWorld('human', 'orc', false)
  world.spawnBuilding('smithy', TEAM_PLAYER, -34, -46, true)
  world.spawnBuilding('archery', TEAM_PLAYER, -46, -34, true)
  for (let i = 0; i < 2; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  world.gold[TEAM_PLAYER] = 5000
  world.wood[TEAM_PLAYER] = 2000
  oneThink(world)
  assertEqual(totalLevels(world, TEAM_PLAYER), 0, 'a rich bank does not research for an army that does not stand')
})

test('AI research fires by mid-game for every faction in scripted sims', () => {
  // Single AI vs an inert enemy base. The bank-dynamics audit's replay
  // predicted first levels ~2:40-2:55 in contested games under the old
  // barracks-research rules; the tech-buildings rework (2026-10-26)
  // inserts the workshop + smithy ahead of the first level, and the
  // measured uncontested first fires are 170-186s across factions.
  // Undead's supply gate pools gold, so it researches at least as
  // early as human.
  const firstFire = new Map<string, number>()
  for (const faction of ['human', 'elf', 'orc', 'undead']) {
    const foe = faction === 'orc' ? 'human' : 'orc'
    const world = makeAiWorld(faction, foe)
    let first = -1
    for (let s = 0; s < 60 * 210 && first < 0; s += 1) {
      stepWorld(world, 1)
      if (totalLevels(world, TEAM_PLAYER) > 0) first = world.matchTime
    }
    firstFire.set(faction, first)
    assert(first > 0, `${faction} researched by 3:30 (first fire ${first.toFixed(0)}s)`)
  }
  assert(
    firstFire.get('undead')! <= firstFire.get('human')!,
    `undead fires no later than human (${firstFire.get('undead')!.toFixed(0)}s vs ${firstFire.get('human')!.toFixed(0)}s)`,
  )
})

test('in sink mode research applies directly, like orc tier upgrades', () => {
  const world = makeAiWorld('human', 'orc', false)
  world.spawnBuilding('smithy', TEAM_PLAYER, -34, -46, true)
  for (let i = 0; i < 8; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 500
  const ai = new OpponentAI(TEAM_PLAYER, 'normal', 'expander')
  ai.setCommandSink(() => {})
  ai.update(world, 1.0) // One think tick.
  assert(world.meleeDmgLvl[TEAM_PLAYER] >= 1, 'research landed without a command round-trip')
})

/** Ticks for a lone worker at a gold mine to complete 3 swings (carry 0 -> 6). */
function ticksForThreeSwings(faction: string): number {
  const world = new World()
  world.factionOfTeam = [faction as never, faction as never]
  world.registerSystem(new GatherSystemImpl())
  const mine = world.spawnResource('gold', 10, 0).id
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
  world.state[worker] = STATE_GATHER
  world.targetId[worker] = mine
  world.moving[worker] = 0
  world.carryAmount[worker] = 0
  world.gatherTimer[worker] = 0
  let ticks = 0
  while (world.carryAmount[worker] < 6 && ticks < 600) {
    world.update(STEP)
    ticks += 1
  }
  assertEqual(world.carryAmount[worker], 6, `${faction} worker completed 3 swings`)
  return ticks
}

test('gather swing cycle scales by mods.gather', () => {
  const human = ticksForThreeSwings('human')
  const elf = ticksForThreeSwings('elf')
  const orc = ticksForThreeSwings('orc')
  const undead = ticksForThreeSwings('undead')
  assert(Math.abs(elf - human) <= 1, `elf (1.0) matches human (1.0): ${elf} vs ${human}`)
  assert(Math.abs(undead - orc) <= 1, `undead (0.9) matches orc (0.9): ${undead} vs ${orc}`)
  const ratio = orc / human
  assert(
    ratio > 1.05 && ratio < 1.2,
    `orc swings slower by the designed 1/0.9 ratio (got ${ratio.toFixed(3)})`,
  )
})
