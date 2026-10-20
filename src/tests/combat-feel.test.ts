/**
 * Combat-feel events — hit flashes and death pops are visual-only:
 * the sim pushes them, the renderer consumes them, and the lockstep
 * hash must never see them. Guards the 2026-10-20 game-feel polish pass
 * (hit flash on struck entities, expanding death pop at kills, loss sting).
 */
import { World, KIND_MELEE, KIND_HALL } from '../core/World.ts'
import { hashWorldState } from '../net/hash.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { suite, test, assert } from './harness.ts'

suite('combat-feel: hit flashes and death pops')

/** Two opposing melee units spawned toe-to-toe; combat system registered only. */
function makeDuelWorld(): World {
  const world = makeWorld()
  const a = world.spawnUnit('melee', 0, 0, 0)
  const b = world.spawnUnit('melee', 1, 1.2, 0)
  // Vision: both must see each other to auto-acquire.
  world.sight[a.id] = 50
  world.sight[b.id] = 50
  return world
}

test('strike pushes a hit flash on the struck entity', () => {
  const world = makeDuelWorld()
  world.hitFlashes.length = 0
  stepWorld(world, 2)
  assert(world.hitFlashes.length > 0, 'expected at least one hit flash after adjacent units trade blows')
  for (const flash of world.hitFlashes) {
    assert(world.entities.has(flash.id), `flashed id ${flash.id} must be a live entity`)
  }
})

test('hit flash and damage number fire together on a strike', () => {
  const world = makeDuelWorld()
  world.hitFlashes.length = 0
  world.damageNumbers.length = 0
  stepWorld(world, 2)
  assert(world.damageNumbers.length > 0, 'damage numbers expected')
  assert(
    world.hitFlashes.length === world.damageNumbers.length,
    `flashes (${world.hitFlashes.length}) should match strikes (${world.damageNumbers.length})`,
  )
})

test('tower strike pushes a hit flash too', () => {
  const world = makeWorld()
  const tower = world.spawnBuilding('tower', 0, 0, 0, true)
  const enemy = world.spawnUnit('melee', 1, 3, 0)
  world.sight[tower.id] = 60
  world.hitFlashes.length = 0
  stepWorld(world, 5)
  assert(
    world.hitFlashes.some((f) => f.id === enemy.id),
    'tower strike should flash the struck enemy',
  )
})

test('kill pushes a death pop at the victim position', () => {
  const world = makeWorld()
  const killer = world.spawnUnit('melee', 0, 0, 0)
  const victim = world.spawnUnit('melee', 1, 1.2, 0)
  const vx = world.positionX[victim.id]
  const vz = world.positionZ[victim.id]
  // Make the kill deterministic and quick: fragilize the victim.
  world.health[victim.id] = 1
  world.maxHealth[victim.id] = 1
  world.sight[killer.id] = 50
  world.sight[victim.id] = 50
  world.deathPops.length = 0
  stepWorld(world, 30)
  assert(!world.entities.has(victim.id), 'victim should be dead')
  assert(world.deathPops.length > 0, 'expected a death pop for the kill')
  const pop = world.deathPops[0]
  assert(Math.abs(pop.x - vx) < 0.5 && Math.abs(pop.z - vz) < 0.5, 'death pop should sit at the kill position')
  assert(pop.kind === KIND_MELEE, 'death pop should record the victim kind')
  assert(pop.team === 1, 'death pop should record the victim team')
})

test('building kill records building kind in the death pop', () => {
  const world = makeWorld()
  const killer = world.spawnUnit('melee', 0, 0, 0)
  const hall = world.spawnBuilding('hall', 1, 4, 0, true)
  world.health[hall.id] = 1
  world.maxHealth[hall.id] = 1
  world.sight[killer.id] = 60
  world.deathPops.length = 0
  stepWorld(world, 60)
  assert(!world.entities.has(hall.id), 'hall should be destroyed')
  assert(
    world.deathPops.length > 0 && world.deathPops[0].kind === KIND_HALL,
    'death pop should record KIND_HALL for the renderer loss-sfx branch',
  )
})

test('visual-only arrays never enter the lockstep hash', () => {
  const world = makeDuelWorld()
  const before = hashWorldState(world)
  world.hitFlashes.push({ id: 7 }, { id: 9 })
  world.deathPops.push({ x: 1, z: 2, r: 0.5, team: 0, kind: KIND_MELEE, age: 0 })
  world.damageNumbers.push({ x: 1, z: 2, amount: 5, team: 0, age: 0 })
  assert(hashWorldState(world) === before, 'visual arrays must not affect the lockstep hash')
})
