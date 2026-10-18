/**
 * Canon name tests — the four primary races' display names must match the
 * game-soul v2.0 roster canon (merged 2026-10-18). These names surface in the
 * command card (header, train buttons, 'Trains' stat).
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import { FACTIONS, FACTION_IDS } from '../data/factions.ts'

suite('canon unit names')

test('human roster matches canon', () => {
  assertEqual(FACTIONS.human.units.worker, 'Peasant', 'human worker')
  assertEqual(FACTIONS.human.units.melee, 'Footman', 'human warrior')
  assertEqual(FACTIONS.human.units.ranged, 'Longbowman', 'human archer')
})

test('elf roster matches canon', () => {
  assertEqual(FACTIONS.elf.units.worker, 'Gatherer', 'elf worker')
  assertEqual(FACTIONS.elf.units.melee, 'Sentinel', 'elf warrior')
  assertEqual(FACTIONS.elf.units.ranged, 'Moon Archer', 'elf archer')
})

test('orc roster matches canon', () => {
  assertEqual(FACTIONS.orc.units.worker, 'Drudge', 'orc worker')
  assertEqual(FACTIONS.orc.units.melee, 'Mauler', 'orc warrior')
  assertEqual(FACTIONS.orc.units.ranged, 'Javelineer', 'orc archer')
})

test('undead roster matches canon', () => {
  assertEqual(FACTIONS.undead.units.worker, 'Husk', 'undead worker')
  assertEqual(FACTIONS.undead.units.melee, 'Gnawer', 'undead warrior')
  assertEqual(FACTIONS.undead.units.ranged, 'Gloom Archer', 'undead archer')
})

test('every faction names all three unit types', () => {
  for (const id of FACTION_IDS) {
    const u = FACTIONS[id].units
    assert(u.worker.length > 0, `${id} names worker`)
    assert(u.melee.length > 0, `${id} names melee`)
    assert(u.ranged.length > 0, `${id} names ranged`)
  }
})
