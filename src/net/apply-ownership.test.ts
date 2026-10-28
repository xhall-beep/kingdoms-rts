/**
 * Apply-path ownership tests — the Game Tester's H2 finding
 * (tech-gates charter, 2026-10-27), closed and pinned:
 *
 * `applyCommand` with {type:'research', buildingId: <enemy smithy>}
 * researched FOR the enemy and charged the ENEMY treasury (measured:
 * foe meleeDmgLvl 0->1, foe gold 100000 -> 99900). researchUpgrade
 * validates the building, never the commander's team. The HUD only
 * renders research buttons on the player's own buildings, so an honest
 * client cannot issue this — but over the PvP wire a tampered client
 * could spend the victim's gold on the victim's research, and the same
 * shape (a command naming a specific building) covers train,
 * cancelTrain, rally and tier upgrade.
 *
 * Building-targeted commands now carry the commanding `team` (the way
 * militia / warhorn always did), and the apply layer refuses a command
 * whose target building belongs to another team: no charge, no effect,
 * no crash — the layer's usual silent refusal. Commands recorded before
 * the field existed (stored logs are JSON) carry no team and keep their
 * historical behavior; the wire codec always carries the byte.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_HALL } from '../core/World.ts'
import { makeWorld } from '../tests/setup.ts'
import { applyCommand } from './apply.ts'
import { encodeMessage, decodeMessage, MsgKind } from './protocol.ts'
import type { Command } from '../session/commands.ts'
import {
  enqueueTrain,
  researchCost,
  trainCostFor,
  trainQueueCount,
} from '../systems/production.ts'

/**
 * Identical staging to research-transport.test.ts: finished tech
 * chains for both teams + rich treasuries, same spawn order, so
 * entity ids are stable within the test.
 */
interface Staged {
  smithy0: number
  barracks0: number
  range0: number
  smithy1: number
  barracks1: number
  hall1: number
}

function stageTech(world: World): Staged {
  world.spawnBuilding('workshop', TEAM_PLAYER, -52, -40, true)
  const smithy0 = world.spawnBuilding('smithy', TEAM_PLAYER, -52, -26, true).id
  const barracks0 = world.spawnBuilding('barracks', TEAM_PLAYER, -26, -54, true).id
  const range0 = world.spawnBuilding('archery', TEAM_PLAYER, -54, -54, true).id
  world.spawnBuilding('workshop', TEAM_ENEMY, 52, 40, true)
  const smithy1 = world.spawnBuilding('smithy', TEAM_ENEMY, 52, 26, true).id
  const barracks1 = world.spawnBuilding('barracks', TEAM_ENEMY, 26, 54, true).id
  world.spawnBuilding('archery', TEAM_ENEMY, 54, 54, true)
  let hall1 = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_ENEMY && world.kind[id] === KIND_HALL) hall1 = id
  }
  world.gold[TEAM_PLAYER] = 100000
  world.gold[TEAM_ENEMY] = 100000
  world.wood[TEAM_PLAYER] = 100000
  world.wood[TEAM_ENEMY] = 100000
  return { smithy0, barracks0, range0, smithy1, barracks1, hall1 }
}

suite('net apply ownership: research (H2)')

test('H2 repro: a research command naming an enemy smithy is refused, nobody charged', () => {
  const w = makeWorld()
  const s = stageTech(w)
  applyCommand(w, { type: 'research', step: 0, team: TEAM_PLAYER, buildingId: s.smithy1, upgrade: 'meleeDmg' })
  assertEqual(w.meleeDmgLvl[TEAM_ENEMY], 0, 'enemy research did NOT land')
  assertEqual(w.gold[TEAM_ENEMY], 100000, 'enemy treasury untouched')
  assertEqual(w.wood[TEAM_ENEMY], 100000, 'enemy wood untouched')
  assertEqual(w.gold[TEAM_PLAYER], 100000, 'commanding treasury untouched either')
  assertEqual(w.meleeDmgLvl[TEAM_PLAYER], 0, 'no research anywhere from the refused command')
})

test('the refusal is symmetric: team 1 cannot research at a team 0 smithy', () => {
  const w = makeWorld()
  const s = stageTech(w)
  applyCommand(w, { type: 'research', step: 0, team: TEAM_ENEMY, buildingId: s.smithy0, upgrade: 'meleeHp' })
  assertEqual(w.meleeHpLvl[TEAM_PLAYER], 0, 'team 0 research did NOT land')
  assertEqual(w.gold[TEAM_PLAYER], 100000, 'team 0 treasury untouched')
  assertEqual(w.gold[TEAM_ENEMY], 100000, 'team 1 treasury untouched')
})

test('own-building research still applies and charges exactly', () => {
  const w = makeWorld()
  const s = stageTech(w)
  applyCommand(w, { type: 'research', step: 0, team: TEAM_PLAYER, buildingId: s.smithy0, upgrade: 'meleeDmg' })
  assertEqual(w.meleeDmgLvl[TEAM_PLAYER], 1, 'own research landed')
  const cost = researchCost(w, TEAM_PLAYER, 'meleeDmg')
  assertEqual(w.gold[TEAM_PLAYER], 100000 - cost.gold, 'charged exactly the research gold')
  assertEqual(w.wood[TEAM_PLAYER], 100000 - cost.wood, 'charged exactly the research wood')
  applyCommand(w, { type: 'research', step: 0, team: TEAM_ENEMY, buildingId: s.smithy1, upgrade: 'meleeDmg' })
  assertEqual(w.meleeDmgLvl[TEAM_ENEMY], 1, 'team 1 own research landed too')
})

test('legacy command without a team field keeps historical behavior (stored logs)', () => {
  // Command logs recorded before the team field existed are plain JSON
  // with no team on building-targeted commands. Replaying them must not
  // silently drop the research they contain.
  const w = makeWorld()
  const s = stageTech(w)
  const legacy = { type: 'research', step: 0, buildingId: s.smithy0, upgrade: 'meleeDmg' } as Command
  applyCommand(w, legacy)
  assertEqual(w.meleeDmgLvl[TEAM_PLAYER], 1, 'team-less legacy research still applies')
})

suite('net apply ownership: same-shape building commands')

test('train at an enemy barracks is refused; own train still queues and charges', () => {
  const w = makeWorld()
  const s = stageTech(w)
  applyCommand(w, { type: 'train', step: 0, team: TEAM_PLAYER, buildingId: s.barracks1, unit: 'melee' })
  assertEqual(trainQueueCount(w, s.barracks1), 0, 'no unit queued for the enemy')
  assertEqual(w.gold[TEAM_ENEMY], 100000, 'enemy not charged for a foreign train')
  applyCommand(w, { type: 'train', step: 0, team: TEAM_PLAYER, buildingId: s.barracks0, unit: 'melee' })
  assertEqual(trainQueueCount(w, s.barracks0), 1, 'own train queued')
  assertEqual(
    w.gold[TEAM_PLAYER],
    100000 - trainCostFor(w, TEAM_PLAYER, 'melee').gold,
    'own train charged exactly',
  )
})

test('cancelTrain at an enemy barracks cannot cancel (or refund) its production', () => {
  const w = makeWorld()
  const s = stageTech(w)
  assert(enqueueTrain(w, s.barracks1, 'melee'), 'enemy active train staged')
  assert(enqueueTrain(w, s.barracks1, 'melee'), 'enemy queued train staged')
  const enemyGold = w.gold[TEAM_ENEMY]
  applyCommand(w, { type: 'cancelTrain', step: 0, team: TEAM_PLAYER, buildingId: s.barracks1, index: -1 })
  applyCommand(w, { type: 'cancelTrain', step: 0, team: TEAM_PLAYER, buildingId: s.barracks1, index: 0 })
  assertEqual(trainQueueCount(w, s.barracks1), 2, 'enemy production intact after foreign cancels')
  assertEqual(w.gold[TEAM_ENEMY], enemyGold, 'no foreign refund moved enemy gold')
})

test('rally at an enemy building cannot move its rally point', () => {
  const w = makeWorld()
  const s = stageTech(w)
  w.rallyX[s.barracks1] = 3
  w.rallyZ[s.barracks1] = 4
  applyCommand(w, { type: 'rally', step: 0, team: TEAM_PLAYER, buildingId: s.barracks1, x: 99, z: 99 })
  assertEqual(w.rallyX[s.barracks1], 3, 'enemy rally X unmoved')
  assertEqual(w.rallyZ[s.barracks1], 4, 'enemy rally Z unmoved')
  applyCommand(w, { type: 'rally', step: 0, team: TEAM_ENEMY, buildingId: s.barracks1, x: 7, z: 8 })
  assertEqual(w.rallyX[s.barracks1], 7, 'own rally applies')
  assertEqual(w.rallyZ[s.barracks1], 8, 'own rally applies')
})

test('tier upgrade at an enemy hall is refused', () => {
  const w = makeWorld()
  const s = stageTech(w)
  assert(s.hall1 !== -1, 'enemy hall staged')
  w.factionOfTeam[TEAM_ENEMY] = 'orc' // tier upgrades are the orc in-place path
  applyCommand(w, { type: 'upgrade', step: 0, team: TEAM_PLAYER, buildingId: s.hall1 })
  assertEqual(w.upgradeLeft[s.hall1], 0, 'no foreign tier upgrade started')
  assertEqual(w.gold[TEAM_ENEMY], 100000, 'enemy not charged for a foreign upgrade')
  applyCommand(w, { type: 'upgrade', step: 0, team: TEAM_ENEMY, buildingId: s.hall1 })
  assert(w.upgradeLeft[s.hall1] > 0, 'own tier upgrade starts')
})

suite('net apply ownership: wire codec')

test('the commanding team survives the wire for building-targeted commands', () => {
  const commands: Command[] = [
    { type: 'research', step: 0, team: 1, buildingId: 8, upgrade: 'meleeDmg' },
    { type: 'train', step: 0, team: 1, buildingId: 8, unit: 'melee' },
    { type: 'cancelTrain', step: 0, team: 0, buildingId: 8, index: -1 },
    { type: 'rally', step: 0, team: 1, buildingId: 8, x: 1, z: 2 },
    { type: 'upgrade', step: 0, team: 0, buildingId: 8 },
  ]
  const decoded = decodeMessage(
    encodeMessage({ kind: MsgKind.Input, turn: 1, player: 1, commands }),
  ) as { commands: Command[] }
  assertEqual(decoded.commands.length, 5, 'all commands round-trip')
  for (let i = 0; i < commands.length; i += 1) {
    const want = commands[i] as { team?: number }
    const got = decoded.commands[i] as { team?: number }
    assertEqual(got.team, want.team, `command ${i} (${commands[i].type}) team survives`)
  }
})
