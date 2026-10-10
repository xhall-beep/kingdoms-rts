/**
 * Protocol tests: exact round-trips for every message and command type,
 * fuzz over random commands, and byte-size budgets (bandwidth matters on
 * mobile data).
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import {
  MsgKind,
  encodeMessage,
  decodeMessage,
  messageSize,
  TURN_HZ,
  STEPS_PER_TURN,
} from './protocol.ts'
import type { NetMessage } from './protocol.ts'
import type { Command } from '../session/commands.ts'
import { SeededRandom } from '../core/Math.ts'

function roundTrip(msg: NetMessage): NetMessage {
  const bytes = encodeMessage(msg)
  assertEqual(bytes.byteLength, messageSize(msg), 'messageSize must be exact')
  return decodeMessage(bytes)
}

function commandsEqual(a: Command, b: Command): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

suite('protocol: basics')
test('turn constants sane', () => {
  assertEqual(TURN_HZ, 4, 'turn hz')
  assertEqual(STEPS_PER_TURN, 15, 'steps per turn')
})

test('hello round-trip', () => {
  const back = roundTrip({ kind: MsgKind.Hello, playerIndex: 1, matchSeed: 12345 })
  assert(back.kind === MsgKind.Hello, 'kind')
  if (back.kind === MsgKind.Hello) {
    assertEqual(back.playerIndex, 1, 'player')
    assertEqual(back.matchSeed, 12345, 'seed')
  }
})

test('hash round-trip (64-bit)', () => {
  const h = 0xdeadbeefcafef00dn
  const back = roundTrip({ kind: MsgKind.Hash, turn: 123456, hash: h })
  assert(back.kind === MsgKind.Hash, 'kind')
  if (back.kind === MsgKind.Hash) {
    assertEqual(back.turn, 123456, 'turn')
    assertEqual(back.hash, h, 'hash bits preserved')
  }
})

test('ping/pong round-trip', () => {
  const back = roundTrip({ kind: MsgKind.Ping, seq: 42, tSendMs: 987654321 })
  assert(back.kind === MsgKind.Ping, 'kind')
  if (back.kind === MsgKind.Ping) {
    assertEqual(back.seq, 42, 'seq')
    assertEqual(back.tSendMs, 987654321, 'timestamp')
  }
})

test('bye round-trip', () => {
  const back = roundTrip({ kind: MsgKind.Bye, reason: 3 })
  assert(back.kind === MsgKind.Bye && back.reason === 3, 'bye')
})

test('snapshot round-trip', () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 0, 17])
  const back = roundTrip({ kind: MsgKind.Snapshot, turn: 80, bytes })
  assert(back.kind === MsgKind.Snapshot, 'kind')
  if (back.kind === MsgKind.Snapshot) {
    assertEqual(back.turn, 80, 'turn')
    assertEqual(back.bytes.length, 6, 'len')
    assertEqual(back.bytes[3], 250, 'content')
  }
})

test('version mismatch rejected', () => {
  const good = encodeMessage({ kind: MsgKind.Hello, playerIndex: 0, matchSeed: 1 })
  good[2] = 99 // corrupt version byte
  let threw = false
  try {
    decodeMessage(good)
  } catch {
    threw = true
  }
  assert(threw, 'bad version must throw, not desync')
})

suite('protocol: commands')
const sampleCommands: Command[] = [
  { type: 'move', step: 0, unitIds: [1, 2, 3], x: 12.5, z: -40.25 },
  { type: 'attack', step: 0, unitIds: [7], targetId: 999 },
  { type: 'attackmove', step: 0, unitIds: [4, 5], x: 0, z: 0 },
  { type: 'gather', step: 0, unitIds: [10, 11, 12, 13], nodeId: 500 },
  { type: 'build', step: 0, workerId: 3, building: 'barracks', x: -17.75, z: 33.125, siteId: 42 },
  { type: 'train', step: 0, buildingId: 8, unit: 'ranged' },
  { type: 'rally', step: 0, buildingId: 8, x: 100.5, z: -100.5 },
  { type: 'patrol', step: 0, unitIds: [21], x: 1.5, z: 2.5 },
  { type: 'stop', step: 0, unitIds: [21, 22] },
  { type: 'hold', step: 0, unitIds: [23] },
]

for (const cmd of sampleCommands) {
  test(`input round-trip: ${cmd.type}`, () => {
    const msg = { kind: MsgKind.Input, turn: 77, player: 0, commands: [cmd] }
    const back = roundTrip(msg)
    assert(back.kind === MsgKind.Input, 'kind')
    if (back.kind === MsgKind.Input) {
      assertEqual(back.turn, 77, 'turn')
      assertEqual(back.commands.length, 1, 'count')
      assert(commandsEqual(back.commands[0], cmd), `command mismatch: ${JSON.stringify(back.commands[0])}`)
    }
  })
}

test('empty input bundle is tiny', () => {
  const bytes = encodeMessage({ kind: MsgKind.Input, turn: 5, player: 1, commands: [] })
  assert(bytes.byteLength <= 12, `empty bundle should be <= 12 bytes, got ${bytes.byteLength}`)
})

test('fuzz: 500 random commands round-trip bit-exact', () => {
  const rng = new SeededRandom(0xF02)
  const types = ['move', 'attack', 'attackmove', 'gather', 'build', 'train', 'rally', 'patrol'] as const
  const buildings = ['hall', 'barracks', 'archery', 'farm'] as const
  const units = ['worker', 'melee', 'ranged'] as const
  for (let i = 0; i < 500; i += 1) {
    const t = types[rng.integer(0, types.length - 1)]
    const n = rng.integer(1, 12)
    const ids: number[] = []
    for (let k = 0; k < n; k += 1) ids.push(rng.integer(1, 2000))
    const x = rng.range(-90, 90)
    const z = rng.range(-90, 90)
    let cmd: Command
    switch (t) {
      case 'move': cmd = { type: 'move', step: 0, unitIds: ids, x, z }; break
      case 'attack': cmd = { type: 'attack', step: 0, unitIds: ids, targetId: rng.integer(1, 2000) }; break
      case 'attackmove': cmd = { type: 'attackmove', step: 0, unitIds: ids, x, z }; break
      case 'gather': cmd = { type: 'gather', step: 0, unitIds: ids, nodeId: rng.integer(1, 2000) }; break
      case 'build': cmd = { type: 'build', step: 0, workerId: ids[0], building: buildings[rng.integer(0, 3)], x, z, siteId: rng.integer(0, 2000) }; break
      case 'train': cmd = { type: 'train', step: 0, buildingId: ids[0], unit: units[rng.integer(0, 2)] }; break
      case 'rally': cmd = { type: 'rally', step: 0, buildingId: ids[0], x, z }; break
      case 'patrol': cmd = { type: 'patrol', step: 0, unitIds: ids, x, z }; break
    }
    // Float32 coordinate precision: compare against f32-rounded originals.
    const f32 = (v: number): number => {
      const d = new DataView(new ArrayBuffer(4))
      d.setFloat32(0, v, true)
      return d.getFloat32(0, true)
    }
    const norm = { ...cmd } as Command
    if ('x' in norm) (norm as { x: number }).x = f32((norm as { x: number }).x)
    if ('z' in norm) (norm as { z: number }).z = f32((norm as { z: number }).z)
    const back = roundTrip({ kind: MsgKind.Input, turn: rng.integer(0, 100000), player: rng.integer(0, 1), commands: [cmd] })
    assert(back.kind === MsgKind.Input && back.commands.length === 1, 'decode')
    if (back.kind === MsgKind.Input) {
      assert(commandsEqual(back.commands[0], norm), `fuzz mismatch at ${i}: ${t}`)
    }
  }
})

test('unknown command tag rejected', () => {
  const bytes = encodeMessage({ kind: MsgKind.Input, turn: 1, player: 0, commands: [sampleCommands[0]] })
  bytes[bytes.length - 1] = 0 // keep valid; corrupt the tag instead:
  bytes[4] = 0xff
  let threw = false
  try {
    decodeMessage(bytes)
  } catch {
    threw = true
  }
  assert(threw, 'bad tag must throw')
})
