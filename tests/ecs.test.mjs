import assert from 'node:assert/strict'
import test from 'node:test'

import { Engine } from '../src/core/Engine.ts'
import { SeededRandom } from '../src/core/Math.ts'
import { World } from '../src/core/World.ts'

test('world generates entities and preallocates deterministic spatial buffers', () => {
  const world = new World({ capacity: 16 })
  const entity = world.createEntity()

  world.setPosition(entity, 1.5, 2.5, 3.5)
  world.setVelocity(entity, 0.25, -0.5, 0.75)

  assert.equal(entity.id, 1)
  assert.equal(world.getEntityCount(), 1)
  assert.equal(world.positionX[entity.id], 1.5)
  assert.equal(world.velocityZ[entity.id], 0.75)
  assert.ok(world.positionX instanceof Float32Array)
  assert.ok(world.velocityX instanceof Float32Array)
})

test('engine runs 60 headless simulation ticks and exposes interpolation alpha', () => {
  const world = new World({ capacity: 16 })
  const entity = world.createEntity()
  world.setPosition(entity, 0, 0, 0)

  let updateCount = 0
  world.registerSystem({
    update(_world, _deltaSeconds) {
      updateCount++
    },
  })

  const engine = new Engine({ world, fixedStepSeconds: 1 / 60 })
  engine.advance(1)

  assert.equal(updateCount, 60)
  assert.equal(engine.getSimulationSteps(), 60)
  assert.ok(engine.getInterpolationAlpha() >= 0)
  assert.ok(engine.getInterpolationAlpha() <= 1)
})

test('seeded RNG produces repeatable deterministic values', () => {
  const first = new SeededRandom(42)
  const second = new SeededRandom(42)

  const firstValues = [first.next(), first.range(0, 1), first.integer(0, 10)]
  const secondValues = [second.next(), second.range(0, 1), second.integer(0, 10)]

  assert.deepEqual(firstValues, secondValues)
})
