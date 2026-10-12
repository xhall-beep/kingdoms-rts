/**
 * Milestone tests — win thresholds grant persistent unlocks.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  createDefaultProfile,
  recordMatchResult,
} from '../profile/profile.ts'
import { checkMilestones, MILESTONES } from '../profile/milestones.ts'

suite('milestones')

test('first win unlocks barracks', () => {
  let p = createDefaultProfile('M1')
  p = recordMatchResult(p, 'skirmish', true)
  const { profile: q, unlocked } = checkMilestones(p)
  assert(q.unlockedBuildings.includes('barracks'), 'barracks unlocked')
  assertEqual(q.buildingLevels['barracks'], 1, 'barracks level 1')
  assertEqual(unlocked.length, 1, 'one reward')
  assert(unlocked[0].includes('Barracks'), 'reward label mentions Barracks')
})

test('losses do not grant unlocks', () => {
  let p = createDefaultProfile('M2')
  p = recordMatchResult(p, 'skirmish', false)
  const { unlocked } = checkMilestones(p)
  assertEqual(unlocked.length, 0, 'no rewards on loss')
  assert(!p.unlockedBuildings.includes('barracks'), 'barracks still locked')
})

test('milestones are claimed once (idempotent)', () => {
  let p = createDefaultProfile('M3')
  p = recordMatchResult(p, 'skirmish', true)
  const first = checkMilestones(p)
  const second = checkMilestones(first.profile)
  assertEqual(second.unlocked.length, 0, 'no double-claim')
})

test('higher tiers unlock at 3/5/10 wins', () => {
  let p = createDefaultProfile('M4')
  for (let i = 0; i < 10; i += 1) p = recordMatchResult(p, 'pvp', true)
  const { profile: q, unlocked } = checkMilestones(p)
  assert(q.unlockedBuildings.includes('archery'), 'archery at 3 wins')
  assert(q.unlockedBuildings.includes('tower'), 'tower at 5 wins')
  assertEqual(q.buildingLevels['hall'], 2, 'hall level 2 at 10 wins')
  assertEqual(unlocked.length, 4, 'all four rewards')
})

test('milestone definitions are sane', () => {
  assertEqual(MILESTONES.length, 4, 'four milestones')
  for (const m of MILESTONES) {
    assert(m.winsRequired > 0, `${m.id} has positive threshold`)
    assert(m.rewardLabel.length > 0, `${m.id} has label`)
  }
})
