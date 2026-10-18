/**
 * Orc in-place upgrading tests (v2.0 spec, section 2: orc racial).
 *
 * War-Halls and Foundries reforge through three tiers without rebuilding:
 * Iron-Bound -> Blood-Forged -> Warlord's Anvil. Each tier adds 40% max HP;
 * Foundries forge tougher soldiers (+15% HP, +10% damage per tier); War-Halls
 * train faster. Buildings can't train while upgrading.
 */
import { World, TEAM_PLAYER } from '../core/World.ts'
import { ProductionSystemImpl, upgradeBuilding, ORC_TIER_NAMES } from '../systems/production.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('orc: in-place upgrading')

function makeWorld(faction: 'orc' | 'human' = 'orc'): World {
  const world = new World()
  world.factionOfTeam = [faction, faction]
  world.registerSystem(new ProductionSystemImpl())
  return world
}

function richWorld(): World {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  return world
}

test('tier names follow the spec', () => {
  assertEqual(ORC_TIER_NAMES[0], 'Iron-Bound', 'tier 1')
  assertEqual(ORC_TIER_NAMES[1], 'Blood-Forged', 'tier 2')
  assertEqual(ORC_TIER_NAMES[2], "Warlord's Anvil", 'tier 3')
})

test('upgrade starts, ticks, and completes in place', () => {
  const world = richWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const maxHp = world.maxHealth[hall]
  assert(upgradeBuilding(world, hall), 'upgrade starts')
  assertEqual(world.tier[hall], 1, 'still tier 1 while upgrading')
  assert(world.upgradeLeft[hall] > 0, 'upgrade timer running')
  stepWorld(world, Math.floor(25 / STEP)) // 1->2 takes 20s
  assertEqual(world.tier[hall], 2, 'reached tier 2')
  assertEqual(world.upgradeLeft[hall], 0, 'timer cleared')
  assert(world.maxHealth[hall] > maxHp, 'max HP grew')
  assert(Math.abs(world.maxHealth[hall] - maxHp * 1.4) < 1, 'exactly +40% HP')
})

test('three tiers max out', () => {
  const world = richWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  assert(upgradeBuilding(world, hall), '1->2 starts')
  stepWorld(world, Math.floor(25 / STEP))
  assert(upgradeBuilding(world, hall), '2->3 starts')
  stepWorld(world, Math.floor(35 / STEP)) // 2->3 takes 30s
  assertEqual(world.tier[hall], 3, 'reached tier 3')
  assert(!upgradeBuilding(world, hall), 'no tier 4')
})

test('only orcs can upgrade, only halls and barracks', () => {
  const orc = richWorld()
  const human = makeWorld('human')
  human.gold[TEAM_PLAYER] = 1000
  human.wood[TEAM_PLAYER] = 1000
  const orcHall = orc.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const humanHall = human.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const orcFarm = orc.spawnBuilding('farm', TEAM_PLAYER, 20, 20, true).id
  assert(!upgradeBuilding(human, humanHall), 'humans cannot upgrade')
  assert(!upgradeBuilding(orc, orcFarm), 'farms cannot upgrade')
  assert(upgradeBuilding(orc, orcHall), 'orc halls can')
})

test('insufficient funds block the upgrade', () => {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 10
  world.wood[TEAM_PLAYER] = 10
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  assert(!upgradeBuilding(world, hall), 'broke orcs cannot reforge')
  assertEqual(world.tier[hall], 1, 'still tier 1')
})

test('buildings cannot train while upgrading', async () => {
  const { enqueueTrain } = await import('../systems/production.ts')
  const world = richWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  assert(upgradeBuilding(world, hall), 'upgrade starts')
  assert(!enqueueTrain(world, hall, 'worker'), 'no training mid-upgrade')
  stepWorld(world, Math.floor(25 / STEP))
  world.supplyCap[TEAM_PLAYER] = 20
  assert(enqueueTrain(world, hall, 'worker'), 'training resumes at tier 2')
})

test('tier-2 foundry forges tougher soldiers', () => {
  const world = richWorld()
  world.supplyCap[TEAM_PLAYER] = 20
  const rax = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true).id
  assert(upgradeBuilding(world, rax), 'foundry upgrade starts')
  stepWorld(world, Math.floor(25 / STEP))
  assertEqual(world.tier[rax], 2, 'foundry at tier 2')

  // Train a soldier from the tier-2 foundry and compare against a fresh spawn.
  // Queue directly through the production system, then tick until spawn.
  world.trainKind[rax] = 1 // KIND_MELEE
  world.trainLeft[rax] = 0.01
  world.trainTotal[rax] = 0.01
  const before = new Set(world.entities.keys())
  world.update(STEP)
  let spawned = -1
  for (const id of world.entities.keys()) {
    if (!before.has(id) && world.kind[id] === 1) spawned = id
  }
  assert(spawned !== -1, 'soldier trained')
  const fresh = world.spawnUnit('melee', TEAM_PLAYER, 50, 50)
  const freshHp = world.maxHealth[fresh.id]
  const freshDmg = world.damage[fresh.id]
  assert(
    world.maxHealth[spawned] > freshHp,
    `tier-2 soldier tougher: ${world.maxHealth[spawned].toFixed(0)} > ${freshHp.toFixed(0)}`,
  )
  assert(
    world.damage[spawned] > freshDmg,
    `tier-2 soldier hits harder: ${world.damage[spawned].toFixed(1)} > ${freshDmg.toFixed(1)}`,
  )
})

test('upgrade command round-trips through the net protocol', async () => {
  const { encodeMessage, decodeMessage, MsgKind } = await import('../net/protocol.ts')
  const msg = {
    kind: MsgKind.Input,
    turn: 3,
    player: 0,
    commands: [{ type: 'upgrade', step: 9, buildingId: 77 } as never],
  }
  const decoded = decodeMessage(encodeMessage(msg))
  const cmds = (decoded as { commands: { type: string; buildingId: number }[] }).commands
  assertEqual(cmds[0].type, 'upgrade', 'command type survives')
  assertEqual(cmds[0].buildingId, 77, 'building id survives')
})

test('tiers survive save/load', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = richWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  assert(upgradeBuilding(world, hall), 'upgrade starts')
  stepWorld(world, Math.floor(25 / STEP))
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assertEqual(restored.tier[hall], 2, 'tier restored')
})
