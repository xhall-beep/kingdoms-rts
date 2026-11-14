/**
 * Per-frame allocation slice (mechanics audit #13): the Engine's spatial
 * snapshot and the World's per-tick spatial-hash entries must reuse
 * buffers instead of allocating every frame/tick. Pure allocation
 * change — no sim behavior may move, so these tests pin both the reuse
 * and the contents (twin parity in determinism.test.ts pins the rest).
 */
import { Engine } from '../core/Engine.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { hashWorldState } from '../net/hash.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('perf-alloc: snapshot reuse')

test('snapshotSpatialStateInto copies into the given buffers, preserving identity', () => {
  const world = makeWorld()
  const u = world.spawnUnit('melee', 0, 5, 7)
  const target: Float32Array[] = []
  world.snapshotSpatialStateInto(target)
  assertEqual(target.length, 6, 'six spatial arrays')
  assertEqual(target[0][u.id], 5, 'positionX copied')
  assertEqual(target[2][u.id], 7, 'positionZ copied')
  const firstSet = [...target]
  // Move the unit and re-snapshot into the same buffers.
  world.positionX[u.id] = 9
  world.positionZ[u.id] = -3
  world.snapshotSpatialStateInto(target)
  for (let i = 0; i < 6; i += 1) {
    assert(target[i] === firstSet[i], `buffer ${i} must be reused, not reallocated`)
  }
  assertEqual(target[0][u.id], 9, 'positionX updated in place')
  assertEqual(target[2][u.id], -3, 'positionZ updated in place')
})

test('snapshotSpatialStateInto reallocates a wrong-length slot', () => {
  const world = makeWorld()
  const target: Float32Array[] = [new Float32Array(3)]
  world.snapshotSpatialStateInto(target)
  assertEqual(target[0].length, world.positionX.length, 'short slot replaced at world length')
  assertEqual(target.length, 6, 'all six slots filled')
})

test('snapshotSpatialState still returns a fresh, correct copy', () => {
  const world = makeWorld()
  const u = world.spawnUnit('melee', 0, 2, 4)
  const a = world.snapshotSpatialState()
  const b = world.snapshotSpatialState()
  assert(a !== b, 'fresh snapshots are distinct objects')
  assert(a[0] !== b[0], 'fresh snapshot buffers are distinct')
  assertEqual(a[0][u.id], 2, 'copy holds the position')
  // Mutating the copy must not touch the world.
  a[0][u.id] = 99
  assertEqual(world.positionX[u.id], 2, 'world untouched by copy mutation')
})

suite('perf-alloc: Engine snapshot double-buffer')

test('advance ping-pongs between exactly two snapshot sets', () => {
  const world = makeWorld()
  const engine = new Engine({ world })
  const seen = new Set<Float32Array[]>()
  const sequence: Float32Array[][] = []
  for (let i = 0; i < 6; i += 1) {
    engine.advance(0)
    const prev = engine.getPreviousSpatialState()
    sequence.push(prev)
    seen.add(prev)
  }
  assertEqual(seen.size, 2, 'exactly two snapshot sets over 6 advances')
  assert(sequence[0] !== sequence[1], 'consecutive advances use different sets')
  assert(sequence[0] === sequence[2], 'set alternates back on the next advance')
  assert(sequence[1] === sequence[3], 'second set alternates back too')
  // Inner buffers are the same objects across alternation.
  for (let i = 0; i < 6; i += 1) {
    assert(sequence[0][i] === sequence[2][i], `inner buffer ${i} reused`)
    assert(sequence[1][i] === sequence[3][i], `inner buffer ${i} reused on the other set`)
  }
})

test('published previous state tracks the world at advance time', () => {
  const world = makeWorld()
  const u = world.spawnUnit('melee', 0, 1, 1)
  const engine = new Engine({ world })
  engine.advance(0)
  assertEqual(engine.getPreviousSpatialState()[0][u.id], 1, 'initial position published')
  world.positionX[u.id] = 42
  engine.advance(0)
  assertEqual(engine.getPreviousSpatialState()[0][u.id], 42, 'moved position published')
})

suite('perf-alloc: spatial-hash entries reuse')

test('hash queries stay correct as the entity count shrinks and regrows', () => {
  const world = makeWorld()
  const units = []
  for (let i = 0; i < 10; i += 1) {
    units.push(world.spawnUnit('melee', 0, i * 2, 0))
  }
  stepWorld(world, 5)
  // Kill half, step, then spawn replacements — the reused entry array
  // truncates on shrink and regrows on spawn.
  for (let i = 0; i < 5; i += 1) world.removeEntity(units[i])
  stepWorld(world, 5)
  const replacements: number[] = []
  for (let i = 0; i < 5; i += 1) {
    replacements.push(world.spawnUnit('melee', 0, 100 + i * 2, 0).id)
  }
  stepWorld(world, 5)
  const found: number[] = []
  world.spatialHash.forEachNear(104, 0, (id) => found.push(id))
  for (const id of replacements) {
    assert(found.includes(id), `replacement ${id} must be in the rebuilt hash`)
  }
  // Removed ids must be gone from their old ground — but note freed ids
  // are recycled by later spawns, so check the OLD neighbourhood, where
  // only the five survivors (x=10..18) may appear.
  const oldGround: number[] = []
  world.spatialHash.forEachNear(4, 0, (id) => oldGround.push(id))
  for (let i = 0; i < 5; i += 1) {
    assert(!oldGround.includes(units[i].id), `removed ${units[i].id} must not linger on old ground`)
  }
  for (let i = 5; i < 10; i += 1) {
    assert(oldGround.includes(units[i].id), `survivor ${units[i].id} must still be on old ground`)
  }
})

test('reused entries do not change the lockstep hash', () => {
  const a = makeWorld()
  const b = makeWorld()
  stepWorld(a, 600)
  stepWorld(b, 600)
  assertEqual(hashWorldState(a), hashWorldState(b), 'identical worlds hash identically after reuse')
})
