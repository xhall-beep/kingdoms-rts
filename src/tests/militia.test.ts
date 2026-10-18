/**
 * Militia Bell tests (v2.0 spec, section 2: human racial).
 *
 * The Town Hall rings the alarm: nearby Peasants become Levy Pikemen for
 * 25 seconds (4x damage, they fight), at the cost of halting resource
 * collection. 120s cooldown. Only humans can ring it.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, STATE_ATTACK, STATE_IDLE } from '../core/World.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('militia: human militia bell')

function makeWorld(faction: 'human' | 'orc' = 'human'): World {
  const world = new World()
  world.factionOfTeam = [faction, faction]
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  return world
}

test('ringing the bell musters nearby peasants', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const near = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  const far = world.spawnUnit('worker', TEAM_PLAYER, 100, 100).id
  const mustered = world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(mustered, 1, 'only the nearby peasant musters')
  assert(world.isMilitia(near), 'nearby peasant is militia')
  assert(!world.isMilitia(far), 'distant peasant stays a worker')
})

test('militia expires after 25 seconds', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(world.isMilitia(peasant), 'militia active')
  stepWorld(world, Math.floor(30 / STEP))
  assert(!world.isMilitia(peasant), 'militia expired after 25s')
})

test('cooldown blocks a second ringing', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  world.spawnUnit('worker', TEAM_PLAYER, 5, 5)
  assert(world.ringMilitiaBell(TEAM_PLAYER) > 0, 'first ring works')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'second ring blocked by cooldown')
  world.matchTime = 130 // past the 120s cooldown
  assert(world.ringMilitiaBell(TEAM_PLAYER) > 0, 'ring works after cooldown')
})

test('non-human factions cannot ring the bell', () => {
  const world = makeWorld('orc')
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  world.spawnUnit('worker', TEAM_PLAYER, 5, 5)
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'orcs have no militia bell')
})

test('militia fight as levy pikemen (4x damage)', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  const enemy = world.spawnUnit('melee', TEAM_ENEMY, 6, 5).id
  world.ringMilitiaBell(TEAM_PLAYER)
  // Force the militia into combat range and let it swing.
  world.state[peasant] = STATE_ATTACK
  world.targetId[peasant] = enemy
  world.moving[peasant] = 0
  world.cooldown[peasant] = 0
  const before = world.health[enemy]
  world.update(STEP)
  const dealt = before - world.health[enemy]
  assert(dealt > 0, `militia dealt damage (${dealt.toFixed(1)})`)
  // Worker base damage 4 x 4 militia bonus = 16 per swing.
  assert(dealt >= 15, `militia hits like a pikeman, dealt ${dealt.toFixed(1)}`)
})

test('militia do not gather while mustered', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.spawnResource('wood', 8, 8)
  world.ringMilitiaBell(TEAM_PLAYER)
  world.state[peasant] = STATE_IDLE
  stepWorld(world, 120)
  assertEqual(world.carryAmount[peasant], 0, 'militia carries nothing')
  assertEqual(world.state[peasant], STATE_IDLE, 'militia holds position')
})

test('militia command round-trips through the net protocol', async () => {
  const { encodeMessage, decodeMessage, MsgKind } = await import('../net/protocol.ts')
  const msg = {
    kind: MsgKind.Input,
    turn: 7,
    player: 0,
    commands: [{ type: 'militia', step: 42, team: 1 } as never],
  }
  const decoded = decodeMessage(encodeMessage(msg))
  assertEqual(decoded.kind, MsgKind.Input, 'message kind survives')
  const cmds = (decoded as { commands: { type: string; team: number }[] }).commands
  assertEqual(cmds.length, 1, 'one command')
  assertEqual(cmds[0].type, 'militia', 'command type survives')
  assertEqual(cmds[0].team, 1, 'team survives')
})

test('militia state survives save/load', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.ringMilitiaBell(TEAM_PLAYER)
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assert(restored.isMilitia(peasant), 'militia flag restored')
  assertEqual(restored.militiaCooldown[TEAM_PLAYER], world.militiaCooldown[TEAM_PLAYER], 'cooldown restored')
})
