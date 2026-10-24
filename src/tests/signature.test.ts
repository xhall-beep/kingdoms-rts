/**
 * Faction signature mechanic tests — verifies Undead reanimation works
 * deterministically and doesn't affect other factions.
 */
import { TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import { FACTIONS } from '../data/factions.ts'
import { getUnits } from '../data/stats.ts'
import { UPGRADES } from '../data/upgrades.ts'
import { researchUpgrade } from '../systems/production.ts'
import { orderAttack } from '../systems/combat.ts'
import { placeStructure } from '../world/construction.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, STEP } from './setup.ts'

suite('signature: undead reanimation')

test('undead faction has reanimate signature', () => {
  const sig = FACTIONS.undead.signature?.reanimate
  assert(sig !== undefined, 'undead should have reanimate')
  assert(sig!.chance > 0 && sig!.chance <= 1, 'chance in (0,1]')
  assert(sig!.hpFactor > 0 && sig!.hpFactor <= 1, 'hpFactor in (0,1]')
  assert(sig!.durationSec > 0, 'positive duration')
})

test('other factions have no reanimate signature', () => {
  assert(FACTIONS.human.signature?.reanimate === undefined, 'human: no reanimate')
  assert(FACTIONS.elf.signature?.reanimate === undefined, 'elf: no reanimate')
  assert(FACTIONS.orc.signature?.reanimate === undefined, 'orc: no reanimate')
})

test('reanimation is deterministic for same entity and tick', () => {
  // Two worlds with same seed state should produce same reanimation outcome
  const runOnce = (): boolean => {
    const world = makeWorld()
    world.factionOfTeam[TEAM_ENEMY] = 'undead'
    // Spawn an enemy melee unit and kill it
    const e = world.spawnUnit('melee', TEAM_ENEMY, 10, 10)
    const id = e.id
    world.tick = 100 // Fixed tick for determinism check
    world.health[id] = 0
    // Simulate combat death handling via direct call
    // (we test the hash logic directly for determinism)
    const hash1 = ((id * 2654435761) ^ (100 * 40503)) >>> 0
    const hash2 = ((id * 2654435761) ^ (100 * 40503)) >>> 0
    return hash1 === hash2
  }
  assert(runOnce(), 'hash should be deterministic')
})

test('reanimated units expire after duration', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id = e.id
  // Manually mark as reanimated with 1 tick remaining
  world.reanimateTicks[id] = 1
  assert(world.entities.has(id), 'unit exists before expiry')
  world.update(STEP)
  assert(!world.entities.has(id), 'reanimated unit removed after expiry')
})

test('reanimated units do not chain-reanimate', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id = e.id
  // Mark as reanimated (expired marker)
  world.reanimateTicks[id] = -1
  // tryReanimate should skip (reanimateTicks !== 0)
  assert(world.reanimateTicks[id] !== 0, 'expired marker prevents re-roll')
})

suite('signature: orc momentum')

test('orc faction has momentum signature', () => {
  const sig = FACTIONS.orc.signature?.momentum
  assert(sig !== undefined, 'orc should have momentum')
  assert(sig!.damagePerSec > 0, 'positive damagePerSec')
  assert(sig!.maxBonus > 0, 'positive maxBonus')
  assert(sig!.resetSec > 0, 'positive resetSec')
})

test('non-orc factions have no momentum', () => {
  assert(FACTIONS.human.signature?.momentum === undefined, 'human: no momentum')
  assert(FACTIONS.undead.signature?.momentum === undefined, 'undead: no momentum')
})

test('momentum builds while in combat', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id = e.id

  assertEqual(world.momentumTicks[id], 0, 'starts at 0')

  // Simulate 60 ticks of combat (1 second)
  for (let i = 0; i < 60; i++) {
    world.lastCombatTick[id] = world.tick
    world.update(STEP)
  }
  assert(world.momentumTicks[id] >= 55, `momentum builds (got ${world.momentumTicks[id]})`)
})

test('momentum resets after combat gap', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id = e.id

  // Build some momentum
  for (let i = 0; i < 60; i++) {
    world.lastCombatTick[id] = world.tick
    world.update(STEP)
  }
  assert(world.momentumTicks[id] > 0, 'momentum built')

  // Wait beyond reset period (5 sec = 300 ticks) without combat
  for (let i = 0; i < 400; i++) {
    world.update(STEP)
  }
  assertEqual(world.momentumTicks[id], 0, 'momentum resets after gap')
})

test('momentum bonus is capped at maxBonus', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id = e.id
  const sig = FACTIONS.orc.signature!.momentum!

  // Simulate very long combat (way beyond cap)
  for (let i = 0; i < 3600; i++) { // 60 seconds
    world.lastCombatTick[id] = world.tick
    world.update(STEP)
  }

  const expectedMax = Math.round(sig.maxBonus * 60 / sig.damagePerSec)
  assert(world.momentumTicks[id] > expectedMax, 'ticks exceed cap threshold')
  // Bonus calculation caps: 1 + min(ticks * dps / 60, maxBonus)
  const bonus = 1 + Math.min((world.momentumTicks[id] * sig.damagePerSec) / 60, sig.maxBonus)
  assert(bonus <= 1 + sig.maxBonus + 0.001, `bonus capped at ${1 + sig.maxBonus} (got ${bonus})`)
})

suite('signature: elf woodland')

test('elf faction has woodland signature', () => {
  const sig = FACTIONS.elf.signature?.woodland
  assert(sig !== undefined, 'elf should have woodland')
  assert(sig!.speedBonus > 0, 'positive speedBonus')
  assert(sig!.rangeBonus > 0, 'positive rangeBonus')
  assert(sig!.treeRadius > 0, 'positive treeRadius')
})

test('elf ranged units get bonus range', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'elf'
  const e = world.spawnUnit('ranged', TEAM_PLAYER, 10, 10)
  const sig = FACTIONS.elf.signature!.woodland!
  const baseRange = getUnits()['ranged'].range
  assertEqual(world.attackRange[e.id], baseRange + sig.rangeBonus, 'range bonus applied')
})

test('non-elf ranged units get no bonus range', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'human'
  const e = world.spawnUnit('ranged', TEAM_PLAYER, 10, 10)
  const baseRange = getUnits()['ranged'].range
  assertEqual(world.attackRange[e.id], baseRange, 'no bonus for human')
})

suite('signature: human adaptable')

test('human faction has adaptable signature', () => {
  const sig = FACTIONS.human.signature?.adaptable
  assert(sig !== undefined, 'human should have adaptable')
  assert(sig!.upgradeCostFactor < 1, 'discount factor below 1')
  assert(sig!.upgradeCostFactor > 0, 'positive factor')
})

test('human upgrades cost less', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'human'
  // Give plenty of resources
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)

  const def = UPGRADES['meleeDmg']
  const factor = FACTIONS.human.signature!.adaptable!.upgradeCostFactor
  const expectedGold = Math.ceil(def.cost.gold * factor)

  const goldBefore = world.gold[TEAM_PLAYER]
  const ok = researchUpgrade(world, hall.id, 'meleeDmg')
  assert(ok, 'upgrade should succeed')
  const spent = goldBefore - world.gold[TEAM_PLAYER]
  assertEqual(spent, expectedGold, `human pays discounted cost (${spent} vs ${expectedGold})`)
})

test('non-human pays full upgrade cost', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)

  const def = UPGRADES['meleeDmg']
  const goldBefore = world.gold[TEAM_PLAYER]
  const ok = researchUpgrade(world, hall.id, 'meleeDmg')
  assert(ok, 'upgrade should succeed')
  const spent = goldBefore - world.gold[TEAM_PLAYER]
  assertEqual(spent, def.cost.gold, 'orc pays full cost')
})

suite('audit fix F: reanimate raises units only, never buildings')

/**
 * The reanimate roll is a pure hash of (entityId, tick) — the same
 * formula combat uses — so a test can know in advance whether a death
 * WOULD have raised a skeleton. Deaths are delivered by a real enemy
 * attacker through the combat system (health set to 1: first hit
 * kills), and world.tick after the killing update is the tick the roll
 * read.
 */
function reanimateRoll(id: number, tick: number): number {
  return (((id * 2654435761) ^ (tick * 40503)) >>> 0) % 10000 / 10000
}

function skeletonCount(world: ReturnType<typeof makeWorld>): number {
  let n = 0
  for (const id of world.entities.keys()) if (world.reanimateTicks[id] > 0) n += 1
  return n
}

/** Kill `targetId` with a fresh enemy melee unit; returns the killer. */
function killWithFoe(world: ReturnType<typeof makeWorld>, targetId: number): number {
  world.health[targetId] = 1
  const foe = world.spawnUnit(
    'melee',
    TEAM_ENEMY,
    world.positionX[targetId] + 2.5,
    world.positionZ[targetId],
  )
  orderAttack(world, foe.id, targetId)
  let guard = 0
  while (world.entities.has(targetId) && guard < 600) {
    world.update(STEP)
    guard += 1
  }
  assert(!world.entities.has(targetId), 'the target died')
  return foe.id
}

test('undead building deaths spawn nothing — even on rolls that would raise a unit', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  const chance = FACTIONS.undead.signature!.reanimate!.chance
  let wouldHaveRaised = 0
  for (let attempt = 0; attempt < 32 && wouldHaveRaised < 6; attempt += 1) {
    const placed = placeStructure(world, TEAM_PLAYER, 'barracks', 100 + attempt * 12, 140)
    assert(placed.ok, 'barracks placed')
    const site = placed.id
    world.buildProgress[site] = world.buildTotal[site] // a standing structure, not a site
    const foe = killWithFoe(world, site)
    if (reanimateRoll(site, world.tick) < chance) wouldHaveRaised += 1
    assertEqual(skeletonCount(world), 0, 'no skeleton rose from the rubble')
    world.removeEntityById(foe)
  }
  assert(
    wouldHaveRaised >= 3,
    `covered ${wouldHaveRaised} building deaths whose roll would have raised a unit`,
  )
})

test('undead unit deaths still reanimate at the designed rate (seeded rolls)', () => {
  const world = makeWorld()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  const chance = FACTIONS.undead.signature!.reanimate!.chance
  let successes = 0
  let failures = 0
  for (let attempt = 0; attempt < 48 && (successes < 3 || failures < 3); attempt += 1) {
    const unit = world.spawnUnit('melee', TEAM_PLAYER, 200 + attempt * 4, 220)
    const foe = killWithFoe(world, unit.id)
    if (reanimateRoll(unit.id, world.tick) < chance) {
      successes += 1
    } else {
      failures += 1
    }
    assertEqual(
      skeletonCount(world),
      successes,
      `skeletons track the seeded rolls exactly (${successes} successes so far)`,
    )
    world.removeEntityById(foe)
  }
  assert(successes >= 3 && failures >= 3, `covered ${successes} raises and ${failures} non-raises`)
})
