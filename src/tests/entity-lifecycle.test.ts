/**
 * Entity lifecycle regression tests — verifies ID recycling prevents
 * exhaustion in long matches (audit finding 3.1).
 */
import { TEAM_PLAYER, NO_TARGET } from '../core/World.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld } from './setup.ts'

suite('entity-lifecycle: ID recycling')

test('removed IDs are recycled for new entities', () => {
  const world = makeWorld()
  const e1 = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const id1 = e1.id
  world.removeEntityById(id1)

  const e2 = world.spawnUnit('melee', TEAM_PLAYER, 20, 20)
  assertEqual(e2.id, id1, 'freed ID should be reused')
})

test('many create/remove cycles do not exhaust capacity', () => {
  const world = makeWorld()
  // Simulate a long match: create and destroy 5000 units
  // (far beyond the 1024 capacity without recycling)
  for (let i = 0; i < 5000; i++) {
    const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
    world.removeEntityById(e.id)
  }
  // Should not throw; world still functional
  const e = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  assert(world.entities.has(e.id), 'world still creates entities after 5000 cycles')
})

test('stale target references are cleared on removal', () => {
  const world = makeWorld()
  const attacker = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const target = world.spawnUnit('melee', TEAM_PLAYER, 20, 20)

  // Attacker targets the victim
  world.targetId[attacker.id] = target.id
  assertEqual(world.targetId[attacker.id], target.id, 'target set')

  // Remove victim — attacker's reference should clear
  world.removeEntityById(target.id)
  assertEqual(world.targetId[attacker.id], NO_TARGET, 'stale target cleared')

  // New entity reuses the ID — attacker should NOT auto-target it
  const replacement = world.spawnUnit('melee', TEAM_PLAYER, 30, 30)
  assertEqual(replacement.id, target.id, 'ID reused')
  assertEqual(world.targetId[attacker.id], NO_TARGET, 'no phantom targeting of reused ID')
})

test('recycling order is deterministic (LIFO)', () => {
  const world = makeWorld()
  const a = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const b = world.spawnUnit('melee', TEAM_PLAYER, 20, 20)
  const c = world.spawnUnit('melee', TEAM_PLAYER, 30, 30)

  // Remove in order a, b, c — free list is [a, b, c]
  world.removeEntityById(a.id)
  world.removeEntityById(b.id)
  world.removeEntityById(c.id)

  // LIFO: c reused first, then b, then a
  const r1 = world.spawnUnit('melee', TEAM_PLAYER, 40, 40)
  const r2 = world.spawnUnit('melee', TEAM_PLAYER, 50, 50)
  const r3 = world.spawnUnit('melee', TEAM_PLAYER, 60, 60)
  assertEqual(r1.id, c.id, 'LIFO: most recent freed ID reused first')
  assertEqual(r2.id, b.id, 'LIFO order')
  assertEqual(r3.id, a.id, 'LIFO order')
})
