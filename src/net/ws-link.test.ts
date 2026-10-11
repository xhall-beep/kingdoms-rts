/**
 * WsLink tests: the live-PvP transport adapter.
 *
 * - send() routes input bundles to sendTurn and hashes to sendHash.
 * - receive() delivers encoded bytes to the peer's onMessage.
 * - Two LockstepPeers linked through WsLinks (in-memory relay standing in
 *   for the Cloudflare worker) execute the same turns with no stall — the
 *   end-to-end proof that live PvP turns actually flow. This is the test
 *   that catches a stubbed transport (send as no-op): turns would never
 *   arrive and both peers would stall forever.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { WsLink } from './ws-link.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnCallbacks } from './turn.ts'
import { MsgKind, encodeMessage, decodeMessage } from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'
import type { Command } from '../session/commands.ts'

suite('ws-link: frame routing')

test('send routes input bundles to sendTurn', () => {
  const turns: InputMsg[] = []
  const hashes: HashMsg[] = []
  const link = new WsLink(
    (m) => turns.push(m),
    (m) => hashes.push(m),
  )
  const bytes = encodeMessage({ kind: MsgKind.Input, turn: 3, player: 0, commands: [] })
  link.send(bytes, 1000)
  assertEqual(turns.length, 1, 'one turn sent')
  assertEqual(hashes.length, 0, 'no hash sent')
  assertEqual(turns[0].turn, 3, 'turn number preserved')
})

test('send routes hashes to sendHash', () => {
  const turns: InputMsg[] = []
  const hashes: HashMsg[] = []
  const link = new WsLink(
    (m) => turns.push(m),
    (m) => hashes.push(m),
  )
  const bytes = encodeMessage({ kind: MsgKind.Hash, turn: 40, hash: 12345n })
  link.send(bytes, 1000)
  assertEqual(hashes.length, 1, 'one hash sent')
  assertEqual(turns.length, 0, 'no turn sent')
  assertEqual(hashes[0].turn, 40, 'hash turn preserved')
})

test('receive delivers encoded bytes to onMessage', () => {
  const link = new WsLink(
    () => {},
    () => {},
  )
  const got: Uint8Array[] = []
  link.onMessage = (data) => got.push(data)
  link.receive({ kind: MsgKind.Input, turn: 1, player: 1, commands: [] })
  assertEqual(got.length, 1, 'one delivery')
  const back = decodeMessage(got[0])
  assert(back.kind === MsgKind.Input, 'decodes as input')
  if (back.kind === MsgKind.Input) assertEqual(back.turn, 1, 'turn preserved')
})

suite('ws-link: two-peer live lockstep')

/** Two LockstepPeers joined by an in-memory relay, like the WS worker. */
function livePair() {
  let linkA: WsLink
  let linkB: WsLink
  const executedA: { turn: number; commands: Command[] }[] = []
  const executedB: { turn: number; commands: Command[] }[] = []
  const mkCallbacks = (executed: { turn: number; commands: Command[] }[]): TurnCallbacks => ({
    executeTurn: (turn, _step, commands) => {
      executed.push({ turn, commands: [...commands] })
    },
    computeHash: () => 0n,
    onRemoteHash: () => {},
    onStall: () => {},
  })
  // Relay: A's frames arrive at B and vice versa, same as the worker relay.
  linkA = new WsLink(
    (m) => linkB.receive(m),
    (m) => linkB.receive(m),
  )
  linkB = new WsLink(
    (m) => linkA.receive(m),
    (m) => linkA.receive(m),
  )
  const a = new LockstepPeer(0, 2, linkA, mkCallbacks(executedA))
  const b = new LockstepPeer(1, 2, linkB, mkCallbacks(executedB))
  return { a, b, executedA, executedB }
}

test('both peers execute the same turns with no stall', () => {
  const { a, b, executedA, executedB } = livePair()
  // Each side issues a command; both must execute both commands per turn.
  a.queueCommand({ type: 'move', step: 0, unitIds: [1], x: 10, z: 10 })
  b.queueCommand({ type: 'patrol', step: 0, unitIds: [2], x: 20, z: 20 })
  let now = 1000
  for (let i = 0; i < 30; i += 1) {
    now += 250 // 4 turns/sec, like the game loop
    a.pump(now)
    b.pump(now)
  }
  assert(executedA.length > 5, `peer A executed turns, got ${executedA.length}`)
  assert(executedB.length > 5, `peer B executed turns, got ${executedB.length}`)
  assertEqual(executedA.length, executedB.length, 'peers stay in lockstep')
  for (let i = 0; i < executedA.length; i += 1) {
    assertEqual(executedA[i].turn, executedB[i].turn, `same turn ${i}`)
    assertEqual(
      executedA[i].commands.length,
      executedB[i].commands.length,
      `same command count on turn ${executedA[i].turn}`,
    )
  }
  console.log(`  live lockstep: ${executedA.length} turns, both peers identical`)
})
