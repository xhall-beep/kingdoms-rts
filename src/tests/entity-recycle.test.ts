/**
 * Entity ID recycling — regression test for the capacity-exhaustion bug.
 * Removed entity IDs must be reused; stale targetId references to removed
 * entities must be cleared before the ID is recycled.
 */
import { World, NO_TARGET } from '../core/World.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('entity id recycling')

test('removed ids are reused for new entities', () => {
  const world = new World({ capacity: 8 })
  const ids: number[] = []
  for (let i = 0; i < 8; i++) ids.push(world.createEntity().id)
  // Remove half.
  for (let i = 0; i < 4; i++) world.removeEntityById(ids[i])
  assertEqual(world.getFreeIdCount(), 4, 'four ids recycled')
  // Create replacements — must succeed without exceeding capacity.
  const fresh: number[] = []
  for (let i = 0; i < 4; i++) fresh.push(world.createEntity().id)
  for (const id of fresh) {
    assert(ids.slice(0, 4).includes(id), `reused a freed id (got ${id})`)
  }
  assertEqual(world.entities.size, 8, 'eight live entities')
})

test('creating past capacity still throws when nothing is freed', () => {
  const world = new World({ capacity: 4 })
  for (let i = 0; i < 4; i++) world.createEntity()
  let threw = false
  try {
    world.createEntity()
  } catch {
    threw = true
  }
  assert(threw, 'throws at capacity with no freed ids')
})

test('stale targetId references are cleared on removal', () => {
  const world = new World({ capacity: 8 })
  const attacker = world.createEntity().id
  const victim = world.createEntity().id
  world.targetId[attacker] = victim
  world.removeEntityById(victim)
  assertEqual(world.targetId[attacker], NO_TARGET, 'target cleared')
  // The recycled id must not silently retarget the attacker.
  const newcomer = world.createEntity().id
  assertEqual(newcomer, victim, 'id recycled')
  assertEqual(world.targetId[attacker], NO_TARGET, 'still no target after recycle')
})

test('recycling is deterministic across identical histories', () => {
  const run = () => {
    const world = new World({ capacity: 16 })
    const ids: number[] = []
    for (let i = 0; i < 10; i++) ids.push(world.createEntity().id)
    world.removeEntityById(ids[3])
    world.removeEntityById(ids[7])
    world.removeEntityById(ids[1])
    const fresh: number[] = []
    for (let i = 0; i < 3; i++) fresh.push(world.createEntity().id)
    return fresh.join(',')
  }
  assertEqual(run(), run(), 'same history yields same recycled ids')
})
