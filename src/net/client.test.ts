/**
 * PvPClient pre-match buffering tests.
 *
 * Regression: turn bundles and hashes arriving between match_start and
 * PvPGame.start() (before setTurnBundleHandler / setHashHandler are called)
 * used to hit the lobby's no-op placeholder handlers and vanish. The
 * lockstep barrier then stalled the match forever — the late-starting peer
 * never received the remote peer's opening turns. Frames must now be
 * buffered and replayed in arrival order once the real handler is set.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { PvPClient } from './client.ts'
import type { PvPClientConfig } from './client.ts'
import { MsgKind, encodeMessage } from './protocol.ts'
import type { InputMsg, HashMsg } from './protocol.ts'

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function turnFrame(turn: number, player: number): string {
  return JSON.stringify({
    kind: 'turn',
    data: b64(encodeMessage({ kind: MsgKind.Input, turn, player, commands: [] })),
  })
}

function hashFrame(turn: number): string {
  return JSON.stringify({
    kind: 'hash',
    data: b64(encodeMessage({ kind: MsgKind.Hash, turn, hash: BigInt(turn) })),
  })
}

function makeClient(): PvPClient {
  const config: PvPClientConfig = {
    serverUrl: 'wss://example.invalid',
    playerId: 'test-player',
    playerName: 'Tester',
    onAssigned: () => {},
    onMatchStart: () => {},
    // The lobby's no-op placeholders (the old code routed into these).
    onTurnBundle: () => {},
    onHash: () => {},
    onOpponentDisconnected: () => {},
    onPlayerJoined: () => {},
  }
  return new PvPClient(config)
}

/** Drive the client's private message path (no WebSocket needed). */
function receive(client: PvPClient, frame: string): void {
  ;(client as unknown as { handleMessage(data: string): void }).handleMessage(frame)
}

suite('pvp-client: pre-match frame buffering')

test('turn bundles arriving before routing are buffered, then replayed in order', () => {
  const client = makeClient()
  receive(client, turnFrame(0, 1))
  receive(client, turnFrame(1, 1))
  receive(client, turnFrame(2, 1))
  // The lobby's placeholder never saw them (no-op) — nothing was delivered.
  const got: InputMsg[] = []
  client.setTurnBundleHandler((b) => got.push(b))
  assertEqual(got.length, 3, 'all three buffered bundles replayed')
  assertEqual(got[0].turn, 0, 'replay preserves arrival order (0)')
  assertEqual(got[1].turn, 1, 'replay preserves arrival order (1)')
  assertEqual(got[2].turn, 2, 'replay preserves arrival order (2)')
})

test('hashes arriving before routing are buffered, then replayed in order', () => {
  const client = makeClient()
  receive(client, hashFrame(4))
  receive(client, hashFrame(8))
  const got: HashMsg[] = []
  client.setHashHandler((m) => got.push(m))
  assertEqual(got.length, 2, 'both buffered hashes replayed')
  assertEqual(got[0].turn, 4, 'hash order preserved (4)')
  assertEqual(got[1].turn, 8, 'hash order preserved (8)')
})

test('frames after routing deliver immediately without buffering', () => {
  const client = makeClient()
  const got: InputMsg[] = []
  const hgot: HashMsg[] = []
  client.setTurnBundleHandler((b) => got.push(b))
  client.setHashHandler((m) => hgot.push(m))
  receive(client, turnFrame(3, 0))
  receive(client, hashFrame(3))
  assertEqual(got.length, 1, 'turn delivered immediately')
  assertEqual(got[0].turn, 3, 'turn number intact')
  assertEqual(hgot.length, 1, 'hash delivered immediately')
  assertEqual(hgot[0].turn, 3, 'hash turn intact')
})

test('routing drains the buffer once; later frames are not double-delivered', () => {
  const client = makeClient()
  receive(client, turnFrame(0, 1))
  const first: InputMsg[] = []
  client.setTurnBundleHandler((b) => first.push(b))
  assertEqual(first.length, 1, 'buffered frame delivered on route')
  const second: InputMsg[] = []
  client.setTurnBundleHandler((b) => second.push(b))
  assertEqual(second.length, 0, 'buffer is empty after first drain')
  receive(client, turnFrame(1, 1))
  assertEqual(second.length, 1, 'new frames go to the current handler')
})

test('buffer is capped so runaway pre-match traffic cannot grow memory', () => {
  const client = makeClient()
  for (let t = 0; t < 70; t += 1) receive(client, turnFrame(t, 1))
  const got: InputMsg[] = []
  client.setTurnBundleHandler((b) => got.push(b))
  assert(got.length <= 64, `buffer capped, got ${got.length}`)
  assertEqual(got.length, 64, 'buffer holds the first 64 frames')
  assertEqual(got[0].turn, 0, 'earliest frames kept')
  assertEqual(got[63].turn, 63, 'latest kept frame')
})
