/**
 * Soul-Ash economy tests (v2.0 spec, section 2: undead racial).
 *
 * The Undead raise no farms. Instead, every unit that dies on the map feeds
 * their supply cap: three corpses render one soul-ash worth of capacity.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { placeStructure } from '../world/construction.ts'
import { STEP } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('soul-ash: undead corpse economy')

function makeWorld(player: 'undead' | 'human' = 'undead'): World {
  const world = new World()
  world.factionOfTeam = [player, 'human']
  world.registerSystem(new CombatSystemImpl())
  return world
}

/** Pit two melee units against each other until one dies. */
function fightToDeath(world: World): void {
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

test('corpses feed the undead supply cap', () => {
  const world = makeWorld()
  const capBefore = world.supplyCap[TEAM_PLAYER]
  // Three duels. Note: undead reanimate (25%) can make a husk die twice,
  // which rightfully harvests twice — so assert the 3:1 conversion ratio.
  for (let i = 0; i < 3; i += 1) fightToDeath(world)
  const harvested = world.soulAsh[TEAM_PLAYER]
  assert(harvested >= 3, `at least three corpses harvested, got ${harvested}`)
  assertEqual(
    world.supplyCap[TEAM_PLAYER] - capBefore,
    Math.floor(harvested / 3),
    'three corpses per point of supply cap',
  )
})

test('enemy deaths feed undead too', () => {
  const world = makeWorld()
  // Kill an enemy unit outright through the combat system.
  const enemy = world.spawnUnit('melee', TEAM_ENEMY, 0, 0).id
  const killer = world.spawnUnit('melee', TEAM_PLAYER, 1, 0).id
  world.health[enemy] = 1
  world.state[killer] = 4
  world.targetId[killer] = enemy
  world.moving[killer] = 0
  world.cooldown[killer] = 0
  world.update(STEP)
  assert(!world.entities.has(enemy), 'enemy died')
  assertEqual(world.soulAsh[TEAM_PLAYER], 1, 'enemy corpse harvested')
})

test('non-undead teams harvest nothing', () => {
  const world = makeWorld('human')
  fightToDeath(world)
  assertEqual(world.soulAsh[TEAM_PLAYER], 0, 'humans harvest no soul-ash')
  assertEqual(world.soulAsh[TEAM_ENEMY], 0, 'humans harvest no soul-ash')
})

test('undead cannot raise farms', () => {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  const res = placeStructure(world, TEAM_PLAYER, 'farm', 20, 20)
  assert(!res.ok, 'undead farm placement refused')
  const ok = placeStructure(world, TEAM_PLAYER, 'barracks', 30, 30)
  assert(ok.ok, 'undead can still raise barracks')
})

test('humans can still raise farms', () => {
  const world = makeWorld('human')
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  const res = placeStructure(world, TEAM_PLAYER, 'farm', 20, 20)
  assert(res.ok, 'human farm placement works')
})

test('soul-ash survives save/load', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  fightToDeath(world)
  fightToDeath(world)
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assertEqual(restored.soulAsh[TEAM_PLAYER], world.soulAsh[TEAM_PLAYER], 'soul-ash restored')
})
