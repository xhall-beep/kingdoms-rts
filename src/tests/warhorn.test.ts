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
  warChargeAtLeast,
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

suite('warhorn: threshold tolerance (tester E2)')

test('1000 single-damage charges can fire the horn', () => {
  // Tester E2 repro: charge accumulated as damage * 0.05 in a float made
  // 1000 x 1-damage charges sum to 49.9999999999993 < HORN_COST (50), so
  // a side that dealt exactly 1000 damage in 1-damage increments could
  // not fire while lump charges landed at exactly 50. The stored sum is
  // still dusty (accumulation arithmetic is untouched, so hashed state
  // evolves bit-identically) — the fix is that the threshold comparison
  // tolerates the dust.
  const world = makeWorld()
  for (let i = 0; i < 1000; i += 1) chargeWarHorn(world, TEAM_PLAYER, 1)
  assert(
    Math.abs(world.warCharge[TEAM_PLAYER] - 50) < 1e-6,
    `stored charge is 50 within dust, got ${world.warCharge[TEAM_PLAYER]}`,
  )
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'the horn fires at exactly 1000 damage dealt')
  assertEqual(world.warCharge[TEAM_PLAYER], 0, 'the spend leaves no negative dust residue')
})

test('equal total damage fires identically across sequences', () => {
  const bySingles = makeWorld()
  for (let i = 0; i < 1000; i += 1) chargeWarHorn(bySingles, TEAM_PLAYER, 1)
  const byFifties = makeWorld()
  for (let i = 0; i < 20; i += 1) chargeWarHorn(byFifties, TEAM_PLAYER, 50)
  const byLump = makeWorld()
  chargeWarHorn(byLump, TEAM_PLAYER, 1000)
  const byMixed = makeWorld()
  for (let i = 0; i < 500; i += 1) chargeWarHorn(byMixed, TEAM_PLAYER, 1)
  for (let i = 0; i < 10; i += 1) chargeWarHorn(byMixed, TEAM_PLAYER, 50)
  const byFractional = makeWorld()
  for (let i = 0; i < 80; i += 1) chargeWarHorn(byFractional, TEAM_PLAYER, 12.5)
  for (const [name, w] of [['singles', bySingles], ['fifties', byFifties], ['lump', byLump], ['mixed', byMixed], ['fractional', byFractional]] as const) {
    assert(warChargeAtLeast(w, TEAM_PLAYER, 50), `${name}: 1000 total damage meets the threshold`)
    assert(soundWarHorn(w, TEAM_PLAYER, 1), `${name}: the horn fires`)
  }
})

test('just below the threshold still cannot fire (tolerance does not over-promote)', () => {
  const singles = makeWorld()
  for (let i = 0; i < 999; i += 1) chargeWarHorn(singles, TEAM_PLAYER, 1)
  assert(!warChargeAtLeast(singles, TEAM_PLAYER, 50), '999 damage does not meet the threshold')
  assert(!soundWarHorn(singles, TEAM_PLAYER, 1), '999 damage cannot fire')
  const long = makeWorld()
  for (let i = 0; i < 900; i += 1) chargeWarHorn(long, TEAM_PLAYER, 1)
  assert(!soundWarHorn(long, TEAM_PLAYER, 1), 'a long sub-threshold accumulation cannot fire either')
})

test('warChargeAtLeast agrees at the AI firing floors (50 and 100)', () => {
  const world = makeWorld()
  for (let i = 0; i < 1000; i += 1) chargeWarHorn(world, TEAM_PLAYER, 1)
  assert(warChargeAtLeast(world, TEAM_PLAYER, 50), 'dusty 50 meets the 50 floor')
  assert(!warChargeAtLeast(world, TEAM_PLAYER, 100), 'dusty 50 does not meet the 100 floor')
  const full = makeWorld()
  for (let i = 0; i < 2000; i += 1) chargeWarHorn(full, TEAM_PLAYER, 1)
  assert(warChargeAtLeast(full, TEAM_PLAYER, 100), '2000 singles meet the full-meter floor')
})

test('sounding then recharging in singles fires twice', () => {
  const world = makeWorld()
  for (let i = 0; i < 1000; i += 1) chargeWarHorn(world, TEAM_PLAYER, 1)
  assert(soundWarHorn(world, TEAM_PLAYER, 2), 'first horn fires')
  assertEqual(world.warCharge[TEAM_PLAYER], 0, 'charge fully spent')
  stepWorld(world, 1300) // let the rally expire
  for (let i = 0; i < 1000; i += 1) chargeWarHorn(world, TEAM_PLAYER, 1)
  assert(soundWarHorn(world, TEAM_PLAYER, 2), 'second horn fires on the recharged meter')
})

test('cap and lump behavior unchanged', () => {
  const world = makeWorld()
  chargeWarHorn(world, TEAM_PLAYER, 1000)
  assertEqual(world.warCharge[TEAM_PLAYER], 50, 'one lump of 1000 damage = exactly 50 (float-exact)')
  chargeWarHorn(world, TEAM_PLAYER, 3000)
  assertEqual(world.warCharge[TEAM_PLAYER], 100, 'still capped at 100')
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
