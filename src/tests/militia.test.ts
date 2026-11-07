/**
 * Militia Bell tests (v2.0 spec, section 2: human racial).
 *
 * The Town Hall rings the alarm: nearby Peasants TRAVEL to the hall
 * (STATE_MUSTER), arm there as Levy Pikemen for 25 seconds (4x
 * damage, they fight) — the levy clock starts at arming, not at the
 * ring — and at expiry return to the hall to hand the pike back
 * (STATE_DISARM). 120s cooldown from the ring. Only humans can ring
 * it. (Town-hall arming trip: Montz's decision 2026-11-06 15:37 EST;
 * the trip's full property suite lives in militia-townhall.test.ts.)
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  STATE_ATTACK,
  STATE_GATHER,
  STATE_IDLE,
  STATE_MUSTER,
} from '../core/World.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('militia: human militia bell')

/** Production system order (tests/setup.ts) — the trip needs the full
 *  pipeline (movement walks the muster, gather detects arrival). */
function makeWorld(faction: 'human' | 'orc' = 'human'): World {
  const world = new World()
  world.factionOfTeam = [faction, faction]
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
  world.registerSystem(new MovementSystemImpl())
  return world
}

function stepUntil(world: World, pred: () => boolean, maxSteps: number): boolean {
  for (let i = 0; i < maxSteps; i += 1) {
    if (pred()) return true
    world.update(STEP)
  }
  return pred()
}

test('ringing the bell calls nearby peasants, who muster on arrival at the hall', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const near = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  const far = world.spawnUnit('worker', TEAM_PLAYER, 100, 100).id
  const called = world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(called, 1, 'only the nearby peasant is called')
  assertEqual(world.state[near], STATE_MUSTER, 'the called peasant is traveling to the hall')
  assert(!world.isMilitia(near), 'he is not militia until he arrives and arms')
  assert(world.isBellDuty(near), 'he is on bell duty from the ring')
  assert(!world.isBellDuty(far), 'distant peasant stays a worker')
  assert(stepUntil(world, () => world.isMilitia(near), 600), 'he musters on arrival')
  assertEqual(world.state[near], STATE_IDLE, 'the armed pikeman stands at the hall')
})

test('militia expires after 25 seconds', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'traveling after the ring')
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'militia active after arming')
  stepWorld(world, Math.floor(30 / STEP))
  assert(!world.isMilitia(peasant), 'militia expired after 25s of service')
  assert(!world.isBellDuty(peasant), 'and the return trip completed inside the window')
})

test('cooldown blocks a second ringing', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  assert(world.ringMilitiaBell(TEAM_PLAYER) > 0, 'first ring works')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'second ring blocked by cooldown')
  // Run the full cycle out; the cooldown (120 s from the ring) still holds.
  assert(stepUntil(world, () => !world.isBellDuty(peasant), 3600), 'the cycle completes')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'still blocked after the cycle — cooldown runs from the ring')
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
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'the peasant arms at the hall')
  // Stage him adjacent to the enemy and let him swing as a pikeman.
  world.positionX[peasant] = world.positionX[enemy] - 0.5
  world.positionZ[peasant] = world.positionZ[enemy]
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
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'the peasant arms')
  stepWorld(world, 120)
  assert(world.isMilitia(peasant), 'still serving')
  assertEqual(world.carryAmount[peasant], 0, 'militia carries nothing')
  assertEqual(world.state[peasant], STATE_IDLE, 'militia holds position')
})

test('mustered militia do not destroy their own gold mine (Finding 1 regression)', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const mine = world.spawnResource('gold', 7, 5).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  // The peasant is mid-gather on the mine when the bell rings: its
  // targetId still points at the node, exactly as in a real match.
  world.state[peasant] = STATE_GATHER
  world.targetId[peasant] = mine
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'the bell takes him off the node')
  stepWorld(world, 120) // 2 seconds: travel + arming + stand
  assert(world.entities.has(mine), 'gold mine survives the militia stand')
  assertEqual(world.amount[mine], 1600, 'mine stock untouched by militia swings')
  assert(world.isMilitia(peasant), 'he is standing militia duty at the hall, not gathering')
})

test('mustered militia do not destroy their own trees (Finding 1 regression)', () => {
  const world = makeWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const tree = world.spawnResource('wood', 7, 5).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.state[peasant] = STATE_GATHER
  world.targetId[peasant] = tree
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'the bell takes him off the tree')
  stepWorld(world, 120)
  assert(world.entities.has(tree), 'tree survives the militia stand')
  assert(world.isMilitia(peasant), 'he is standing militia duty at the hall, not gathering')
})

test('combat ignores a pre-set friendly target', () => {
  const world = makeWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 4, 4).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'the peasant arms')
  // A stale pre-set target on a friendly building must never be honored.
  world.targetId[peasant] = hall
  world.state[peasant] = STATE_ATTACK
  const before = world.health[hall]
  stepWorld(world, 120)
  assertEqual(world.health[hall], before, 'own hall takes no militia damage')
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

test('militia state survives save/load (mid-trip seam)', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'mid-trip at save time')
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assertEqual(restored.state[peasant], STATE_MUSTER, 'the trip state is restored')
  assertEqual(restored.targetId[peasant], hall, 'the trip destination is restored')
  assertEqual(restored.militiaUntil[peasant], 0, 'no levy clock runs before arming — before or after load')
  assertEqual(restored.militiaCooldown[TEAM_PLAYER], world.militiaCooldown[TEAM_PLAYER], 'cooldown restored')
})
