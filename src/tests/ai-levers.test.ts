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
 *    the gold floor keeps it out of the early economy; in sink mode
 *    research applies directly, like the AI's orc tier upgrades.
 *  - The gather swing cycle scales by mods.gather: orc/undead (0.9)
 *    swing slower than human/elf (1.0), by the designed ratio.
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_WORKER,
  STATE_GATHER,
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

test('AI researches once its bank clears the floor', () => {
  const world = makeAiWorld('human', 'orc')
  world.spawnBuilding('barracks', TEAM_PLAYER, -34, -46, true)
  world.spawnBuilding('archery', TEAM_PLAYER, -46, -34, true)
  // A standing army at the attack threshold: research upgrades the army
  // you have — the step stands down while the army is still forming.
  for (let i = 0; i < 8; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  world.gold[TEAM_PLAYER] = 5000
  world.wood[TEAM_PLAYER] = 2000
  stepWorld(world, 600) // 10 simulated seconds.
  assert(world.meleeDmgLvl[TEAM_PLAYER] >= 1, 'melee damage researched by mid-game')
  const total =
    world.meleeDmgLvl[TEAM_PLAYER] + world.meleeHpLvl[TEAM_PLAYER] + world.rangedDmgLvl[TEAM_PLAYER]
  assert(total >= 3, `the ladder keeps climbing (total levels ${total})`)
})

test('AI does not research out of a thin early bank', () => {
  const world = makeAiWorld('human', 'orc')
  world.spawnBuilding('barracks', TEAM_PLAYER, -34, -46, true)
  // Army present, so only the gold floor can be what blocks research.
  for (let i = 0; i < 8; i += 1) world.spawnUnit('melee', TEAM_PLAYER, -38 + i, -30)
  // Starting stock is 200 gold — below the research floor.
  stepWorld(world, 300)
  assertEqual(world.meleeDmgLvl[TEAM_PLAYER], 0, 'no research below the gold floor')
  assertEqual(world.meleeHpLvl[TEAM_PLAYER], 0, 'no research below the gold floor')
  assertEqual(world.rangedDmgLvl[TEAM_PLAYER], 0, 'no research below the gold floor')
})

test('in sink mode research applies directly, like orc tier upgrades', () => {
  const world = makeAiWorld('human', 'orc', false)
  world.spawnBuilding('barracks', TEAM_PLAYER, -34, -46, true)
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
