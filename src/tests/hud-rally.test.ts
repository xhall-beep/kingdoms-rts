/**
 * Rally announcements (game-feel slice, 2026-11-15): sounding the War
 * Horn used to change nothing on screen, so a 50-charge buff read as
 * a dead tap. RallyWatch names each rally in the banner lane the
 * moment it starts, for either team, exactly once per sounding.
 *
 * The watch is pure sim-state observation (no DOM): these tests pin
 * its detection rules — rallyKind transitions for Gale/Ironblood,
 * the charge-drop signature for Second Wind — including the two
 * honesty rules: Coward's Decay never announces (its drop lands at
 * zero), and a sound masked by same-frame damage charging is missed,
 * never misannounced.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import { World, TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import { RallyWatch, rallyBannerText } from '../ui/hud.ts'
import { RALLY_NAMES, soundWarHorn } from '../systems/warhorn.ts'
import { stepWorld } from './setup.ts'

function chargedWorld(): World {
  const world = new World()
  world.factionOfTeam = ['human', 'human']
  return world
}

suite('rally watch: banner text')

test('RALLY_NAMES has all three rallies (audit #12: Second Wind had no label)', () => {
  assertEqual(RALLY_NAMES[1], 'Gale March', 'gale')
  assertEqual(RALLY_NAMES[2], 'Ironblood', 'ironblood')
  assertEqual(RALLY_NAMES[3], 'Second Wind', 'second wind')
})

test('player and enemy lines name the rally and its effect', () => {
  assertEqual(rallyBannerText({ team: 0, rally: 1 }), '📯 Gale March! +30% speed', 'player gale')
  assertEqual(rallyBannerText({ team: 0, rally: 2 }), '📯 Ironblood! +25% damage', 'player ironblood')
  assertEqual(rallyBannerText({ team: 0, rally: 3 }), '📯 Second Wind! army healed', 'player wind')
  assertEqual(rallyBannerText({ team: 1, rally: 2 }), '⚔️ Enemy Ironblood! +25% damage', 'enemy ironblood')
})

suite('rally watch: Gale / Ironblood transitions')

test('fresh world announces nothing, even with a rally already sounding', () => {
  const world = chargedWorld()
  world.warCharge[TEAM_PLAYER] = 50
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'gale sounds')
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'pre-existing rally is not announced')
})

test('player Gale announces once, then silence on repeat observations', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_PLAYER] = 60
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'gale sounds')
  const found = watch.observe(world)
  assertEqual(found.length, 1, 'one announcement')
  assertEqual(found[0].team, 0, 'player team')
  assertEqual(found[0].rally, 1, 'gale')
  assertEqual(watch.observe(world).length, 0, 'no repeat while rallying')
  assertEqual(watch.observe(world).length, 0, 'still silent')
})

test('enemy Ironblood announces for the enemy team', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_ENEMY] = 60
  assert(soundWarHorn(world, TEAM_ENEMY, 2), 'ironblood sounds')
  const found = watch.observe(world)
  assertEqual(found.length, 1, 'one announcement')
  assertEqual(found[0].team, 1, 'enemy team')
  assertEqual(found[0].rally, 2, 'ironblood')
})

test('rally expiry re-arms: a second sounding announces again', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_PLAYER] = 60
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'first gale sounds')
  assertEqual(watch.observe(world).length, 1, 'first announced')
  // Rally expires (20s): the sim clears rallyKind; the watch follows.
  world.rallyKind[TEAM_PLAYER] = 0
  world.rallyUntil[TEAM_PLAYER] = 0
  world.matchTime += 25
  assertEqual(watch.observe(world).length, 0, 'expiry itself announces nothing')
  world.warCharge[TEAM_PLAYER] = 60
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'second gale sounds')
  const found = watch.observe(world)
  assertEqual(found.length, 1, 'second sounding announced')
  assertEqual(found[0].rally, 1, 'gale again')
})

test('both teams sounding in one frame announce once each', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_PLAYER] = 60
  world.warCharge[TEAM_ENEMY] = 60
  assert(soundWarHorn(world, TEAM_PLAYER, 1), 'player gale sounds')
  assert(soundWarHorn(world, TEAM_ENEMY, 2), 'enemy ironblood sounds')
  const found = watch.observe(world)
  assertEqual(found.length, 2, 'two announcements')
  assertEqual(found[0].team, 0, 'player first')
  assertEqual(found[1].team, 1, 'enemy second')
})

suite('rally watch: Second Wind charge signature')

test('Second Wind announces via its charge drop (real soundWarHorn path)', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  world.warCharge[TEAM_PLAYER] = 75
  assertEqual(watch.observe(world).length, 0, 'baseline latches 75')
  assert(soundWarHorn(world, TEAM_PLAYER, 3), 'second wind sounds')
  assertEqual(world.rallyKind[TEAM_PLAYER], 0, 'no rally state for second wind')
  const found = watch.observe(world)
  assertEqual(found.length, 1, 'one announcement')
  assertEqual(found[0].team, 0, 'player team')
  assertEqual(found[0].rally, 3, 'second wind')
  assertEqual(watch.observe(world).length, 0, 'no repeat')
})

test("Coward's Decay never announces — not even from exactly 50 charge", () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  world.warCharge[TEAM_PLAYER] = 50
  assertEqual(watch.observe(world).length, 0, 'baseline latches 50')
  // Decay empties the horn: the drop lands at zero, which the rule
  // excludes — a 50-drop to zero is indistinguishable from a
  // Second Wind sounded at exactly 50, so it stays silent.
  world.warCharge[TEAM_PLAYER] = 0
  assertEqual(watch.observe(world).length, 0, 'decay from 50 is silent')
  world.warCharge[TEAM_PLAYER] = 80
  assertEqual(watch.observe(world).length, 0, 're-baseline at 80')
  world.warCharge[TEAM_PLAYER] = 0
  assertEqual(watch.observe(world).length, 0, 'decay from 80 is silent')
})

test('a sound masked by same-frame damage charging is missed, never misannounced', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  world.warCharge[TEAM_PLAYER] = 60
  assertEqual(watch.observe(world).length, 0, 'baseline latches 60')
  // Damage (+10) then a Second Wind (-50) inside one frame: the
  // observed drop is 40, under the 50 signature, so no announcement.
  world.warCharge[TEAM_PLAYER] = 20
  assertEqual(watch.observe(world).length, 0, 'masked sound stays silent')
})

test('charging from damage alone never announces', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_PLAYER] = 30
  assertEqual(watch.observe(world).length, 0, 'charge gain is silent')
  world.warCharge[TEAM_ENEMY] = 45
  assertEqual(watch.observe(world).length, 0, 'enemy charge gain is silent')
})

suite('rally watch: match reset')

test('a fresh world re-arms the watch', () => {
  const first = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(first).length, 0, 'baseline')
  first.warCharge[TEAM_PLAYER] = 60
  assert(soundWarHorn(first, TEAM_PLAYER, 2), 'ironblood sounds')
  assertEqual(watch.observe(first).length, 1, 'announced on first world')
  // A new match whose horn is already sounding must not announce.
  const second = chargedWorld()
  second.warCharge[TEAM_PLAYER] = 50
  assert(soundWarHorn(second, TEAM_PLAYER, 1), 'gale sounds on second world')
  assertEqual(watch.observe(second).length, 0, 'fresh world re-baselines silently')
  assertEqual(watch.observe(second).length, 0, 'still silent on second world')
})

test('stepWorld: a rally sounded mid-match announces on the next observation', () => {
  const world = chargedWorld()
  const watch = new RallyWatch()
  assertEqual(watch.observe(world).length, 0, 'baseline')
  world.warCharge[TEAM_ENEMY] = 90
  assert(soundWarHorn(world, TEAM_ENEMY, 1), 'enemy gale sounds')
  stepWorld(world, 5)
  const found = watch.observe(world)
  assertEqual(found.length, 1, 'announced after ticks pass')
  assertEqual(found[0].team, 1, 'enemy team')
  assertEqual(found[0].rally, 1, 'gale')
})
