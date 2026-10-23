/**
 * Racial passive tests (v2.0 spec, section 2 — completing the founding races).
 *
 * Orc Plunder: damaging enemy buildings yields gold (10% of damage dealt).
 * Creeping Blight: undead units regenerate 2% max HP/sec after 5s out of combat.
 * Tilled Farmland: human workers near a finished farm work 15% faster.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_TREE, STATE_ATTACK, STATE_GATHER, STATE_IDLE } from '../core/World.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('racial passives: plunder, blight, farmland')

function combatWorld(faction: 'orc' | 'undead' | 'human' = 'orc'): World {
  const world = new World()
  world.factionOfTeam = [faction, 'human']
  world.registerSystem(new CombatSystemImpl())
  return world
}

test('orc plunder: sacking buildings yields gold', () => {
  const world = combatWorld('orc')
  world.gold[TEAM_PLAYER] = 0
  const raider = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const farm = world.spawnBuilding('farm', TEAM_ENEMY, 1, 0, true).id
  world.state[raider] = STATE_ATTACK
  world.targetId[raider] = farm
  world.moving[raider] = 0
  world.cooldown[raider] = 0
  world.update(STEP)
  assert(world.gold[TEAM_PLAYER] > 0, `plunder paid out ${world.gold[TEAM_PLAYER].toFixed(1)}g`)
})

test('no plunder for non-orcs, no plunder on units', () => {
  const world = combatWorld('human')
  world.gold[TEAM_PLAYER] = 0
  const soldier = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const farm = world.spawnBuilding('farm', TEAM_ENEMY, 1, 0, true).id
  world.state[soldier] = STATE_ATTACK
  world.targetId[soldier] = farm
  world.moving[soldier] = 0
  world.cooldown[soldier] = 0
  world.update(STEP)
  assertEqual(world.gold[TEAM_PLAYER], 0, 'humans plunder nothing')
})

test('creeping blight: undead regen out of combat', () => {
  const world = combatWorld('undead')
  const ghoul = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  world.health[ghoul] = world.maxHealth[ghoul] * 0.5
  world.lastCombatTick[ghoul] = world.tick - 6 * 60 // 6s of peace
  world.state[ghoul] = STATE_IDLE
  const before = world.health[ghoul]
  stepWorld(world, 60) // 1 second
  assert(world.health[ghoul] > before, 'blight knits the wound')
  const expected = before + world.maxHealth[ghoul] * 0.02
  assert(
    Math.abs(world.health[ghoul] - expected) < world.maxHealth[ghoul] * 0.005,
    'regen is ~2% max HP/sec',
  )
})

test('no blight in combat or for the living', () => {
  const world = combatWorld('undead')
  const ghoul = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  world.health[ghoul] = world.maxHealth[ghoul] * 0.5
  world.lastCombatTick[ghoul] = world.tick // just fought
  const before = world.health[ghoul]
  stepWorld(world, 60)
  assertEqual(world.health[ghoul], before, 'no regen right after combat')

  const humanWorld = combatWorld('human')
  const footman = humanWorld.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  humanWorld.health[footman] = humanWorld.maxHealth[footman] * 0.5
  humanWorld.lastCombatTick[footman] = humanWorld.tick - 60 * 60
  const hb = humanWorld.health[footman]
  stepWorld(humanWorld, 60)
  assertEqual(humanWorld.health[footman], hb, 'the living do not regenerate')
})

test('tilled farmland: humans work faster near farms', () => {
  const mk = (): { world: World; worker: number } => {
    const world = new World()
    world.factionOfTeam = ['human', 'human']
    world.registerSystem(new GatherSystemImpl())
    world.spawnBuilding('farm', TEAM_PLAYER, 0, 0, true)
    const worker = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
    return { world, worker }
  }
  const near = mk() // worker at (5,5), farm at (0,0): within aura
  const far = mk()
  // Move the far worker out of the aura.
  far.world.positionX[far.worker] = 100
  far.world.positionZ[far.worker] = 100

  // Time how long each takes to fill a swing: run gather timers.
  const swings = (w: World, id: number): number => {
    w.spawnResource('wood', w.positionX[id] + 1, w.positionZ[id])
    w.state[id] = STATE_GATHER
    const node = [...w.entities.keys()].find((e) => w.kind[e] === KIND_TREE)!
    w.targetId[id] = node
    w.moving[id] = 0
    w.gatherTimer[id] = 0
    let ticks = 0
    while (w.carryAmount[id] <= 0 && ticks < 600) {
      w.update(STEP)
      ticks += 1
    }
    return ticks
  }
  const nearTicks = swings(near.world, near.worker)
  const farTicks = swings(far.world, far.worker)
  assert(nearTicks < farTicks, `aura hastens gathering: ${nearTicks} < ${farTicks} ticks`)
})

test('farmland aura is human-only', () => {
  const world = new World()
  world.factionOfTeam = ['orc', 'orc']
  world.registerSystem(new GatherSystemImpl())
  world.spawnBuilding('farm', TEAM_PLAYER, 0, 0, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  // Orc worker next to a farm: gather timer advances at the base rate.
  world.spawnResource('wood', 6, 5)
  const node = [...world.entities.keys()].find((e) => world.kind[e] === KIND_TREE)!
  world.state[worker] = STATE_GATHER
  world.targetId[worker] = node
  world.moving[worker] = 0
  world.gatherTimer[worker] = 0
  world.update(STEP)
  // No aura haste for orcs: the timer advances at the plain faction
  // gather rate — mods.gather 0.9 (wired 2026-10-22; before that the
  // modifier was dead and this pin read the unmodified 1/60). With the
  // aura it would be 1.15x that.
  const expected = (1 / 60) * 0.9
  assert(
    Math.abs(world.gatherTimer[worker] - expected) < 1e-6,
    'orcs get no farmland haste',
  )
})
