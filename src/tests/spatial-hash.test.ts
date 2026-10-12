/**
 * Spatial hash tests — determinism vs linear scan, and performance sanity.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import { SpatialHash } from '../core/spatial-hash.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { test, assert } from './harness.ts'

test('spatial hash covers full sight circle', () => {
  const hash = new SpatialHash(24)
  // Entity at center, target at distance 19 (within 24-cell 3x3)
  hash.rebuild([
    { id: 0, x: 0, z: 0 },
    { id: 1, x: 19, z: 0 },
    { id: 2, x: 0, z: -19 },
    { id: 3, x: 100, z: 100 }, // far away, different cells
  ])
  const seen: number[] = []
  hash.forEachNear(0, 0, (id) => seen.push(id))
  assert(seen.includes(0), 'sees self cell')
  assert(seen.includes(1), 'sees target at distance 19')
  assert(seen.includes(2), 'sees target at distance -19')
  assert(!seen.includes(3), 'does not see far entity')
})

test('sequence numbers follow insertion order', () => {
  const hash = new SpatialHash(24)
  hash.rebuild([
    { id: 5, x: 0, z: 0 },
    { id: 3, x: 1, z: 1 },
    { id: 9, x: 2, z: 2 },
  ])
  assert(hash.sequenceOf(5) < hash.sequenceOf(3), 'seq follows insertion, not id')
  assert(hash.sequenceOf(3) < hash.sequenceOf(9), 'seq follows insertion, not id')
})

test('combat targeting unchanged with spatial hash (regression)', () => {
  // Bare world + combat system: one melee unit, two enemies at different distances.
  // The nearer must be targeted — exercises findNearestEnemy via the hash.
  const world = new World()
  world.registerSystem(new CombatSystemImpl())
  const me = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const far = world.spawnUnit('melee', TEAM_ENEMY, 10, 0)
  const near = world.spawnUnit('melee', TEAM_ENEMY, 5, 0)
  // Run one combat tick; the unit should acquire the nearer enemy
  world.update(1 / 60)
  const target = world.targetId[me.id]
  assert(target === near.id, `targets nearer enemy (got ${target}, want ${near.id})`)
  assert(target !== far.id, 'does not target farther enemy')
})
