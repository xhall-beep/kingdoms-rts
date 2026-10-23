/**
 * Undead supply-trap regression tests (audit 2026-10-22).
 *
 * The trap: undead raise no farms, so their supply cap grows only through
 * Soul-Ash — but the AI filled the entire base cap (10) with workers and
 * `enqueueTrain` hard-refuses soldiers past cap, so undead could never
 * field the army that makes corpses. Balance series result: 0W-15L-3D.
 *
 * The fix, pinned here:
 *  - Soul-Ash converts at 1 corpse = +1 cap (soul-ash.test.ts pins the
 *    ratio itself; this file pins determinism of the accrual).
 *  - The undead AI reserves supply for an army instead of worker-filling
 *    the whole cap — while farm factions keep filling theirs.
 *  - Creeping Blight's out-of-combat delay is the designed 5 seconds
 *    (pinned in simulated seconds below; world.tick advances at
 *    WORLD_TICKS_PER_SECOND = 60/s, not at TICK_RATE 20 — the earlier
 *    pin in TICK_RATE units measured only 1.67 s of sim time).
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_WORKER,
  KIND_MELEE,
  KIND_RANGED,
} from '../core/World.ts'
import { WORLD_TICKS_PER_SECOND } from '../core/time.ts'
import { seedScenario } from '../scenario.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { hashWorldState, hashToHex } from '../net/hash.ts'
import { STEP } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('undead supply trap: soul-ash, AI discipline, blight timing')

/** Full-stack AI-vs-AI world, registered in makeWorld() order + both AIs. */
function makeAiWorld(playerFaction: string, enemyFaction: string): World {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new BellSystemImpl())
  world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'expander'))
  world.registerSystem(new OpponentAI(TEAM_ENEMY, 'normal', 'expander'))
  seedScenario(world, playerFaction as never, enemyFaction as never)
  return world
}

function countKind(world: World, team: number, kind: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === kind) n += 1
  }
  return n
}

test('undead AI never worker-locks the cap, and fields soldiers', () => {
  const world = makeAiWorld('undead', 'human')
  const capAtStart = world.supplyCap[TEAM_PLAYER]
  let maxWorkersBeforeAsh = 0
  let maxSoldiers = 0
  // Six sim-minutes: long enough for barracks + first soldiers and the
  // First Bell, short enough to stay a unit test.
  for (let step = 0; step < 6 * 3600 && world.winner === -1; step += 1) {
    world.update(STEP)
    if (world.soulAsh[TEAM_PLAYER] === 0) {
      // No corpse yet → cap is unchanged; every worker above
      // cap - reserve would be the trap closing again.
      const workers = countKind(world, TEAM_PLAYER, KIND_WORKER)
      if (workers > maxWorkersBeforeAsh) maxWorkersBeforeAsh = workers
    }
    const soldiers =
      countKind(world, TEAM_PLAYER, KIND_MELEE) + countKind(world, TEAM_PLAYER, KIND_RANGED)
    if (soldiers > maxSoldiers) maxSoldiers = soldiers
  }
  assert(
    maxWorkersBeforeAsh <= capAtStart - 4,
    `undead workers stopped at ${capAtStart - 4} (army reserve), peaked at ${maxWorkersBeforeAsh}`,
  )
  assert(maxSoldiers >= 2, `undead fielded an army (peak soldiers ${maxSoldiers})`)
})

test('farm-faction AI still fills toward its full worker target', () => {
  const world = makeAiWorld('human', 'orc')
  let maxWorkers = 0
  for (let step = 0; step < 3 * 3600 && world.winner === -1; step += 1) {
    world.update(STEP)
    const workers = countKind(world, TEAM_PLAYER, KIND_WORKER)
    if (workers > maxWorkers) maxWorkers = workers
  }
  // Expander target is 12 and farms lift the cap: a human AI must blow
  // straight past the undead reserve line (6). Proves the discipline is
  // undead-only, not a global economy slowdown.
  assert(maxWorkers >= 9, `human AI grew its economy freely (peak workers ${maxWorkers})`)
})

test('soul-ash accrual is deterministic: identical fights, identical hash', () => {
  const runDuels = (): string => {
    const world = new World()
    world.factionOfTeam = ['undead', 'human']
    world.registerSystem(new CombatSystemImpl())
    for (let duel = 0; duel < 3; duel += 1) {
      const a = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
      const b = world.spawnUnit('melee', TEAM_ENEMY, 1, 0).id
      world.state[a] = 4 // STATE_ATTACK
      world.state[b] = 4
      world.targetId[a] = b
      world.targetId[b] = a
      world.moving[a] = 0
      world.moving[b] = 0
      for (let i = 0; i < 60 * 60 && world.entities.has(a) && world.entities.has(b); i += 1) {
        world.update(STEP)
      }
    }
    assert(world.soulAsh[TEAM_PLAYER] >= 3, 'duels produced corpses to harvest')
    return hashToHex(hashWorldState(world))
  }
  assertEqual(runDuels(), runDuels(), 'same inputs, same hash — ash accrual is reproducible')
})

test('creeping blight: regen starts at the designed 5 seconds out of combat', () => {
  const world = new World()
  world.factionOfTeam = ['undead', 'human']
  world.registerSystem(new CombatSystemImpl())
  const ghoul = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const half = world.maxHealth[ghoul] / 2
  world.health[ghoul] = half
  world.lastCombatTick[ghoul] = world.tick
  // Expressed in simulated seconds: at the 1/60 step, one sim second is
  // WORLD_TICKS_PER_SECOND world updates. (The previous pin counted
  // 5 * TICK_RATE = 100 updates = 1.67 sim-seconds and called it 5 s.)
  const advanceSeconds = (sec: number): void => {
    const n = Math.round(sec * WORLD_TICKS_PER_SECOND)
    for (let i = 0; i < n; i += 1) world.update(STEP)
  }
  advanceSeconds(4.9)
  assertEqual(world.health[ghoul], half, 'no blight regen before 5s out of combat')
  advanceSeconds(0.3)
  assert(world.health[ghoul] > half, 'blight regen underway just after 5s')
})
