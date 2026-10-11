/**
 * Standard Battle stats — verifies the tournament stat table switches
 * correctly and covers all unit types.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import { getUnits, setStatsMode, getStatsMode } from '../data/stats.ts'
import { UNITS } from '../data/units.ts'
import { STANDARD_UNITS, STANDARD_RULESET } from '../data/standard.ts'

suite('standard-stats: mode switching')

test('defaults to base stats', () => {
  setStatsMode('base')
  assertEqual(getStatsMode(), 'base')
  assert(getUnits() === UNITS, 'should return base UNITS')
})

test('switches to tournament stats in standard mode', () => {
  setStatsMode('standard')
  assertEqual(getStatsMode(), 'standard')
  assert(getUnits() === STANDARD_UNITS, 'should return STANDARD_UNITS')
  assert(getUnits().worker.hp > 0, 'worker has hp')
  assert(getUnits().melee.hp > 0, 'melee has hp')
  assert(getUnits().ranged.hp > 0, 'ranged has hp')
  // Restore for other tests
  setStatsMode('base')
  assert(getUnits() === UNITS, 'should restore base UNITS')
})

test('has a versioned ruleset identifier', () => {
  assert(/^standard-v\d+$/.test(STANDARD_RULESET), 'ruleset is versioned')
})
