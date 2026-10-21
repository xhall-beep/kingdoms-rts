/**
 * Lockstep tests: the determinism proof.
 * Two sims, real wire protocol, real reliability layer, scripted players —
 * hashes must match every exchange over full matches.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { runLockstepMatch, createLockstepSession } from './session.ts'
import { hashWorldState } from './hash.ts'
import { applyCommand } from './apply.ts'
import { makeWorld, stepWorld } from '../tests/setup.ts'
import { SEASON_GROWING, SEASON_WINTER } from '../systems/season.ts'
import { BELL_TIMES } from '../systems/bells.ts'
import {
  NET_PERFECT,
  NET_LAN,
  NET_WIFI,
  NET_LTE,
  NET_BAD,
} from './transport.ts'

suite('net lockstep: determinism proof')

test('loopback: 5-minute match, zero desyncs', () => {
  // 1200 turns = 300 sim-seconds = 5 minutes.
  const report = runLockstepMatch({ turns: 1200, net: NET_PERFECT })
  assertEqual(report.turnsExecuted, 1200, 'all turns executed')
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
  assert(report.hashesCompared >= 1200 / 40 - 1, `hashes exchanged, got ${report.hashesCompared}`)
  console.log(
    `  5-min loopback: ${report.hashesCompared} hashes, ` +
    `${(report.bytesPerMinute / 1024).toFixed(2)} KB/min/player`,
  )
})

test('loopback: 10-minute match, zero desyncs', () => {
  const report = runLockstepMatch({ turns: 2400, net: NET_PERFECT })
  assertEqual(report.turnsExecuted, 2400, 'all turns executed')
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
})

test('bandwidth: under 5 KB/min/player on loopback', () => {
  const report = runLockstepMatch({ turns: 1200, net: NET_PERFECT })
  assert(
    report.bytesPerMinute < 5 * 1024,
    `bandwidth budget: ${(report.bytesPerMinute / 1024).toFixed(2)} KB/min/player`,
  )
})

suite('net lockstep: adverse networks')

for (const [name, profile] of [
  ['lan', NET_LAN],
  ['wifi', NET_WIFI],
  ['lte', NET_LTE],
] as const) {
  test(`${name}: 3-minute match, zero desyncs`, () => {
    const report = runLockstepMatch({ turns: 720, net: profile, netSeed: 7 })
    assertEqual(report.turnsExecuted, 720, 'all turns executed')
    assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
    console.log(
      `  ${name}: ${report.hashesCompared} hashes, ${report.stalls} stalls, ` +
        `${report.transportDropped} dropped, maxStall ${report.maxStallMs.toFixed(0)}ms`,
    )
  })
}

test('bad network (200ms/5% loss): completes, zero desyncs', () => {
  const report = runLockstepMatch({ turns: 480, net: NET_BAD, netSeed: 99 })
  assertEqual(report.turnsExecuted, 480, 'all turns executed despite loss')
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
  assert(report.transportDropped > 0, 'adversity actually happened')
  console.log(
    `  bad-net: ${report.transportDropped} dropped, ${report.stalls} stalls, ` +
      `maxStall ${report.maxStallMs.toFixed(0)}ms`,
  )
})

test('different network seeds both stay in sync', () => {
  for (const seed of [1, 2, 3]) {
    const report = runLockstepMatch({ turns: 240, net: NET_LTE, netSeed: seed })
    assertEqual(report.desyncs, 0, `seed ${seed}: ${report.desyncLog.join('; ')}`)
  }
})

test('input delay 1 turn also stays in sync', () => {
  const report = runLockstepMatch({ turns: 480, net: NET_WIFI, inputDelayTurns: 1 })
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
})

test('input delay 3 turns also stays in sync', () => {
  const report = runLockstepMatch({ turns: 480, net: NET_WIFI, inputDelayTurns: 3 })
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
})

suite('net lockstep: desync recovery')

test('fault injection: desync detected, snapshot resync recovers', () => {
  const session = createLockstepSession({ turns: 400, net: NET_LTE, netSeed: 11 })
  // Run to turn 100, then corrupt peer 1.
  while (session.peers[0].getCurrentTurn() < 100) session.tick()
  session.corruptPeer(1)
  // Continue until BOTH peers reach turn 400 (resync may leave one behind).
  let guard = 0
  while (
    session.peers.some((p) => p.getCurrentTurn() < 400) &&
    guard < 500000
  ) {
    session.tick()
    guard += 1
  }
  const report = session.getReport()
  assert(report.desyncs > 0, 'the injected fault must be detected')
  assert(report.resyncs > 0, 'resync must fire')
  assertEqual(report.desyncs, report.resyncs, 'every desync gets exactly one resync')
  // After resync, the worlds must agree again (same turn, same hash).
  assertEqual(session.peers[0].getCurrentTurn(), session.peers[1].getCurrentTurn(), 'turns re-converged')
  assertEqual(
    hashWorldState(session.worlds[0]),
    hashWorldState(session.worlds[1]),
    'worlds re-converged after resync',
  )
  console.log(`  fault-injection: ${report.desyncs} desync(s), ${report.resyncs} resync(s), recovered`)
})

suite('net lockstep: season wheel in session worlds')

test('session worlds turn to winter at the Second Bell, in sync', () => {
  // Second Bell rings at 360 sim-seconds = turn 1440 (4 turns/sim-second).
  // Run 1500 turns (375 s) so both peers step well past the turn.
  const TURNS = 1500
  const session = createLockstepSession({ turns: TURNS, net: NET_PERFECT })
  let guard = 0
  const maxGuard = (TURNS / 4) * 1000 / 5 + 100000
  while (
    session.peers.some((p) => p.getCurrentTurn() < TURNS) &&
    guard < maxGuard
  ) {
    session.tick()
    guard += 1
  }
  const report = session.getReport()
  assertEqual(report.turnsExecuted, TURNS, 'all turns executed')
  assertEqual(report.desyncs, 0, `desyncs: ${report.desyncLog.join('; ')}`)
  for (let p = 0; p < 2; p += 1) {
    const w = session.worlds[p]
    assertEqual(w.bellsRung[1], 1, `peer ${p}: second bell rung`)
    assertEqual(w.season, SEASON_WINTER, `peer ${p}: season turned to winter`)
  }
  assertEqual(
    hashWorldState(session.worlds[0]),
    hashWorldState(session.worlds[1]),
    'peers hash identically after the season turn',
  )
})

test('session-factory worlds: no flip before 6:00, flip hashes differently', () => {
  // Direct stepping of two makeWorld worlds (the session world factory):
  // identical steps must keep them identical on both sides of the turn,
  // and the winter state must hash differently from the no-flip state.
  const a = makeWorld()
  const b = makeWorld()
  const stepsTo = (seconds: number): number => Math.floor(seconds / (1 / 60))
  stepWorld(a, stepsTo(BELL_TIMES[1] - 1))
  stepWorld(b, stepsTo(BELL_TIMES[1] - 1))
  assertEqual(a.season, SEASON_GROWING, 'still growing just before 6:00')
  assertEqual(b.season, SEASON_GROWING, 'peer world also growing')
  assertEqual(hashWorldState(a), hashWorldState(b), 'identical before the turn')
  stepWorld(a, 120)
  stepWorld(b, 120)
  assertEqual(a.season, SEASON_WINTER, 'winter after the Second Bell')
  assertEqual(b.season, SEASON_WINTER, 'peer world also winter')
  const winterHash = hashWorldState(a)
  assertEqual(hashWorldState(b), winterHash, 'identical after the turn')
  // No-flip control: the same world state with the season held at growing
  // must hash differently — the flip is really in the hashed state.
  a.season = SEASON_GROWING
  assert(hashWorldState(a) !== winterHash, 'no-flip control hashes differently')
  a.season = SEASON_WINTER
})

suite('net surrender')

test('surrender forfeits: opponent wins, both sims identical', () => {
  const a = makeWorld()
  const b = makeWorld()
  applyCommand(a, { type: 'surrender', step: 0, player: 1 })
  applyCommand(b, { type: 'surrender', step: 0, player: 1 })
  assertEqual(a.winner, 0, 'player 1 surrenders -> player 0 wins')
  assertEqual(b.winner, a.winner, 'both sims end identically')
})

test('surrender cannot flip an already-decided result', () => {
  const w = makeWorld()
  w.winner = 1 // natural victory already recorded
  applyCommand(w, { type: 'surrender', step: 0, player: 1 })
  assertEqual(w.winner, 1, 'a surrender racing a natural victory must not flip it')
})
