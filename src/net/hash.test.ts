/**
 * Hash + snapshot tests: stability, sensitivity, and bit-exact restore.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { makeWorld, stepWorld } from '../tests/setup.ts'
import { hashWorldState, hashToHex } from './hash.ts'
import { snapshotWorld, restoreWorld } from './snapshot.ts'
import { TEAM_PLAYER } from '../core/World.ts'
import { orderMove } from '../systems/movement.ts'

suite('net hash')
test('same world, same hash (stable)', () => {
  const w = makeWorld()
  const h1 = hashWorldState(w)
  const h2 = hashWorldState(w)
  assertEqual(h1, h2, 'hash must be stable')
  assertEqual(hashToHex(h1).length, 16, 'hex format')
})

test('two identically-seeded worlds hash equal', () => {
  const a = makeWorld()
  const b = makeWorld()
  assertEqual(hashWorldState(a), hashWorldState(b), 'identical seeds must match')
})

test('single-bit state change flips the hash', () => {
  const a = makeWorld()
  const b = makeWorld()
  b.positionX[5] += 0.000001
  assert(hashWorldState(a) !== hashWorldState(b), 'hash must be sensitive')
})

test('economy change flips the hash', () => {
  const a = makeWorld()
  const b = makeWorld()
  b.gold[TEAM_PLAYER] += 1
  assert(hashWorldState(a) !== hashWorldState(b), 'economy covered')
})

test('entity removal flips the hash', () => {
  const a = makeWorld()
  const b = makeWorld()
  const first = [...b.entities.keys()][0]
  b.removeEntityById(first)
  assert(hashWorldState(a) !== hashWorldState(b), 'entity set covered')
})

test('hash survives 60 sim-seconds identically on two worlds', () => {
  const a = makeWorld()
  const b = makeWorld()
  // Same scripted input on both.
  for (const w of [a, b]) {
    const workers: number[] = []
    for (const id of w.entities.keys()) {
      if (w.team[id] === TEAM_PLAYER && w.kind[id] === 0) workers.push(id)
    }
    if (workers[0] !== undefined) orderMove(w, workers[0], 10, 10)
  }
  stepWorld(a, 3600)
  stepWorld(b, 3600)
  assertEqual(hashWorldState(a), hashWorldState(b), 'divergence-free after 3600 steps')
})

suite('net snapshot')
test('snapshot/restore is bit-exact', () => {
  const a = makeWorld()
  stepWorld(a, 600)
  const before = hashWorldState(a)
  const bytes = snapshotWorld(a)
  const b = makeWorld()
  stepWorld(b, 123) // dirty the target first
  restoreWorld(b, bytes)
  assertEqual(hashWorldState(b), before, 'restored hash must match')
})

test('snapshot size is sane', () => {
  const w = makeWorld()
  const bytes = snapshotWorld(w)
  // ~40 arrays x 1024 x 4B + fog + overhead ≈ under 300KB.
  assert(bytes.byteLength < 300 * 1024, `snapshot ${bytes.byteLength}B too big`)
  console.log(`  snapshot size: ${(bytes.byteLength / 1024).toFixed(1)} KB`)
})

test('corrupt magic rejected', () => {
  const w = makeWorld()
  const bytes = snapshotWorld(w)
  bytes[0] = 0
  let threw = false
  try {
    restoreWorld(makeWorld(), bytes)
  } catch {
    threw = true
  }
  assert(threw, 'bad magic must throw')
})
