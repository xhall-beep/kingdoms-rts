/**
 * PvP session tests: the WsLink adapter routes frames correctly, and two
 * PvPSessions linked through it stay in lockstep with identical state.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { makeWorld } from '../tests/setup.ts'
import { WsLink, PvPSession } from './pvp-session.ts'
import { MsgKind, encodeMessage, decodeMessage } from './protocol.ts'
import { hashWorldState, hashToHex } from './hash.ts'

suite('pvp-session: WsLink')

test('send routes input bundles as turn frames', () => {
  const frames: { kind: string; data: string }[] = []
  const link = new WsLink((kind, data) => frames.push({ kind, data }))
  const bytes = encodeMessage({ kind: MsgKind.Input, turn: 3, player: 0, commands: [] })
  link.send(bytes, 1000)
  assertEqual(frames.length, 1, 'one frame')
  assertEqual(frames[0].kind, 'turn', 'kind')
  const back = decodeMessage(
    Uint8Array.from(atob(frames[0].data), (c) => c.charCodeAt(0)),
  )
  assert(back.kind === MsgKind.Input, 'decodes as input')
})

test('send routes hashes as hash frames', () => {
  const frames: { kind: string; data: string }[] = []
  const link = new WsLink((kind, data) => frames.push({ kind, data }))
  const bytes = encodeMessage({ kind: MsgKind.Hash, turn: 40, hash: 12345n })
  link.send(bytes, 1000)
  assertEqual(frames.length, 1, 'one frame')
  assertEqual(frames[0].kind, 'hash', 'kind')
})

test('receive delivers bytes to onMessage', () => {
  const link = new WsLink(() => {})
  const got: Uint8Array[] = []
  link.onMessage = (data) => {
    got.push(data)
  }
  const bytes = encodeMessage({ kind: MsgKind.Input, turn: 1, player: 1, commands: [] })
  link.receive(bytes)
  assertEqual(got.length, 1, 'one delivery')
  assertEqual(got[0].byteLength, bytes.byteLength, 'bytes delivered')
})

test('receiveFrame decodes base64 relay frames', () => {
  const link = new WsLink(() => {})
  const got: Uint8Array[] = []
  link.onMessage = (data) => {
    got.push(data)
  }
  const bytes = encodeMessage({ kind: MsgKind.Hash, turn: 40, hash: 999n })
  let s = ''
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i])
  link.receiveFrame('hash', btoa(s))
  assertEqual(got.length, 1, 'frame delivered')
  const back = decodeMessage(got[0])
  assert(back.kind === MsgKind.Hash, 'decodes as hash')
})

suite('pvp-session: two-peer lockstep')

function linkedPair(): { a: PvPSession; b: PvPSession } {
  const worldA = makeWorld()
  const worldB = makeWorld()
  let linkA: WsLink
  let linkB: WsLink
  // In-memory relay: frames cross immediately, like the Cloudflare worker.
  linkA = new WsLink((kind, data) => linkB.receiveFrame(kind, data))
  linkB = new WsLink((kind, data) => linkA.receiveFrame(kind, data))
  const a = new PvPSession(0, worldA, linkA)
  const b = new PvPSession(1, worldB, linkB)
  return { a, b }
}

test('both peers execute the same commands identically', () => {
  const { a, b } = linkedPair()
  // Peer 0 orders a worker to move; peer 1 holds a unit.
  a.queueCommand({ type: 'move', step: 0, unitIds: [1], x: 10, z: 10 })
  b.queueCommand({ type: 'hold', step: 0, unitIds: [6] })
  let nowMs = 1000
  // Pump until well past the input delay (2 turns) and hash exchange.
  for (let i = 0; i < 400; i += 1) {
    nowMs += 25
    a.pump(nowMs)
    b.pump(nowMs)
    if (a.currentTurn >= 50 && b.currentTurn >= 50) break
  }
  assert(a.currentTurn >= 50, `peer A advanced (turn ${a.currentTurn})`)
  assert(b.currentTurn >= 50, `peer B advanced (turn ${b.currentTurn})`)
  assertEqual(a.desyncCount, 0, 'no desyncs on A')
  assertEqual(b.desyncCount, 0, 'no desyncs on B')
  assertEqual(
    hashToHex(hashWorldState(a.world)),
    hashToHex(hashWorldState(b.world)),
    'worlds identical',
  )
})

test('stop command executes on both peers', () => {
  const { a, b } = linkedPair()
  a.queueCommand({ type: 'stop', step: 0, unitIds: [2] })
  let nowMs = 1000
  for (let i = 0; i < 200; i += 1) {
    nowMs += 25
    a.pump(nowMs)
    b.pump(nowMs)
    if (a.currentTurn >= 20 && b.currentTurn >= 20) break
  }
  assertEqual(a.desyncCount, 0, 'no desyncs')
  assertEqual(
    hashToHex(hashWorldState(a.world)),
    hashToHex(hashWorldState(b.world)),
    'worlds identical after stop',
  )
})
