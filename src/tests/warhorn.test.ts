/**
 * War Horn tests (v2.0 spec, section 3).
 *
 * Dealing damage charges the horn (0-100). 50 charge sounds a rally:
 * Gale March (+30% move/attack speed), Ironblood (+25% damage),
 * Second Wind (30% heal). 45s of peace empties the horn (Coward's Decay).
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, STATE_ATTACK } from '../core/World.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import {
  WarHornSystemImpl,
  soundWarHorn,
  chargeWarHorn,
  rallyDamageMult,
  rallySpeedMult,
} from '../systems/warhorn.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('warhorn: rallies')

function makeWorld(): World {
  const world = new World()
  world.factionOfTeam = ['human', 'human']
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new WarHornSystemImpl())
  return world
}

function duel(world: World): void {
  const a = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  const b = world.spawnUnit('melee', TEAM_ENEMY, 1, 0).id
  world.state[a] = STATE_ATTACK
  world.state[b] = STATE_ATTACK
  world.targetId[a] = b
  world.targetId[b] = a
  world.moving[a] = 0
  world.moving[b] = 0
  world.cooldown[a] = 0
  world.cooldown[b] = 0
  for (let i = 0; i < 30 && world.entities.has(a) && world.entities.has(b); i += 1) {
    world.update(STEP)
  }
}

test('dealing damage charges the horn', () => {
  const world = makeWorld()
  assertEqual(world.warCharge[TEAM_PLAYER], 0, 'starts empty')
  duel(world)
  assert(world.warCharge[TEAM_PLAYER] > 0, `charged to ${world.warCharge[TEAM_PLAYER].toFixed(1)}`)
  assert(world.warCharge[TEAM_PLAYER] <= 100, 'capped at 100')
})

test('horn needs 50 charge to sound', () => {
  const world = makeWorld()
  world.warCharge[TEAM_PLAYER] = 49
  assert(!soundWarHorn(world, TEAM_PLAYER, 1), '49 charge is not enough')
  world.warCharge[TEAM_PLAYER] = 50
  assert(soundWarHorn(world, TEAM_PLAYER, 1), '50 charge sounds Gale March')
  assertEqual(world.warCharge[TEAM_PLAYER], 0, 'charge spent')
})

test('ironblood boosts damage 25%', () => {
  const world = makeWorld()
  world.warCharge[TEAM_PLAYER] = 100
  assert(soundWarHorn(world, TEAM_PLAYER, 2), 'ironblood sounds')
  assertEqual(rallyDamageMult(world, TEAM_PLAYER), 1.25, 'damage mult active')
  assertEqual(rallyDamageMult(world, TEAM_ENEMY), 1, 'enemy unaffected')
})

test('gale march quickens stride 30%', () => {
  const world = makeWorld()
  world.warCharge[TEAM_PLAYER] = 100
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'gale sounds')
  assertEqual(rallySpeedMult(world, TEAM_PLAYER), 1.3, 'speed mult active')
})

test('second wind heals the army 30%', () => {
  const world = makeWorld()
  const soldier = world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id
  world.health[soldier] = world.maxHealth[soldier] * 0.4
  world.warCharge[TEAM_PLAYER] = 100
  assert(soundWarHorn(world, TEAM_PLAYER, 3), 'second wind sounds')
  const healed = world.health[soldier] / world.maxHealth[soldier]
  assert(Math.abs(healed - 0.7) < 0.01, `healed to 70%, got ${(healed * 100).toFixed(0)}%`)
  // Second Wind is instant: no lingering rally.
  assertEqual(world.rallyKind[TEAM_PLAYER], 0, 'no rally state for second wind')
})

test('rallies expire after 20 seconds', () => {
  const world = makeWorld()
  world.warCharge[TEAM_PLAYER] = 100
  soundWarHorn(world, TEAM_PLAYER, 2)
  assertEqual(rallyDamageMult(world, TEAM_PLAYER), 1.25, 'active')
  stepWorld(world, Math.floor(25 / STEP))
  assertEqual(rallyDamageMult(world, TEAM_PLAYER), 1, 'expired')
})

test("coward's decay: 45s of peace empties the horn", () => {
  const world = makeWorld()
  chargeWarHorn(world, TEAM_PLAYER, 1000)
  assert(world.warCharge[TEAM_PLAYER] > 0, 'charged')
  // 46 seconds of peace: tick the world without dealing damage.
  stepWorld(world, 46 * 60)
  assertEqual(world.warCharge[TEAM_PLAYER], 0, 'decay emptied the horn')
})

test('warhorn command round-trips through the net protocol', async () => {
  const { encodeMessage, decodeMessage, MsgKind } = await import('../net/protocol.ts')
  const msg = {
    kind: MsgKind.Input,
    turn: 3,
    player: 0,
    commands: [{ type: 'warhorn', step: 9, team: 0, rally: 2 } as never],
  }
  const decoded = decodeMessage(encodeMessage(msg))
  const cmds = (decoded as { commands: { type: string; team: number; rally: number }[] }).commands
  assertEqual(cmds[0].type, 'warhorn', 'command type survives')
  assertEqual(cmds[0].rally, 2, 'rally kind survives')
})

test('war horn state survives save/load', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWorld()
  chargeWarHorn(world, TEAM_PLAYER, 1200)
  const save = serializeWorld(world, 0, [])
  const restored = new World()
  deserializeWorld(restored, save)
  assertEqual(restored.warCharge[TEAM_PLAYER], world.warCharge[TEAM_PLAYER], 'charge restored')
})
