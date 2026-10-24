/**
 * PvP-vs-AI practice tests — the coverage hole that let the practice
 * deadlock ship (bfed062): PvpAiGame / thinkAi / injectRemote had zero
 * tests, so a targeting bug that starved lockstep at turn 1 forever was
 * invisible to the suite.
 *
 * The old thinkAi injected each AI bundle at peer.getNextSendTurn()
 * (= sentUpTo + 1). pump()'s send loop races sentUpTo inputDelay turns
 * ahead of execution, so turns 1..inputDelay were never injected and
 * never backfilled — lockstep executes strictly in order, so only turn
 * 0 ever ran: no progression, and a queued surrender never even got
 * bundled, let alone executed (no end modal). The fix injects one
 * bundle per think for the next sequential turn, mirroring a real
 * remote peer's send loop.
 *
 * These tests drive the REAL PvpAiGame against a REAL LockstepPeer on
 * virtual 250ms ticks (the production interval's cadence), with a stub
 * GameComposition over a real test world. start() itself needs the DOM
 * (window timers, localStorage faction settings), so the tests flip the
 * running flag and call thinkAi/pump directly — the same calls the
 * production interval makes, in the same order.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { makeWorld } from '../tests/setup.ts'
import { PvpAiGame } from './pvp-ai.ts'
import type { LockstepPeer } from './turn.ts'
import type { GameComposition } from '../main.ts'
import { serializeWorld } from '../session/save-load.ts'
import type { World } from '../core/World.ts'

interface Internals {
  thinkAi(): void
  peer: LockstepPeer
  running: boolean
}

function makeGame(onMatchEnd?: (won: boolean) => void): {
  game: PvpAiGame
  world: World
  statusLog: Array<string | null>
  internals: Internals
} {
  const world = makeWorld()
  const statusLog: Array<string | null> = []
  const composition = {
    engine: { world, pause: () => {}, resume: () => {} },
    systems: { opponent: {} },
    inputController: {
      setCommandListener: () => {},
      setDeferredExecution: () => {},
    },
    hud: {
      setPvpStatus: (msg: string | null) => {
        statusLog.push(msg)
      },
    },
  } as unknown as GameComposition
  const game = new PvpAiGame({
    composition,
    tier: 'normal',
    pristineSave: serializeWorld(world, 0, []),
    onMatchEnd,
  })
  const internals = game as unknown as Internals
  internals.running = true // start() sets this; start() itself needs the DOM
  return { game, world, statusLog, internals }
}

/** One production interval tick: AI thinks, then the peer pumps. */
function tick(internals: Internals, now: { ms: number }): void {
  internals.thinkAi()
  internals.peer.pump(now.ms)
  now.ms += 250
}

suite('net pvp-ai: practice lockstep')

test('practice progresses continuously well past turn 1 (deadlock regression)', () => {
  const { game, world, statusLog, internals } = makeGame()
  const now = { ms: 1000 }
  for (let i = 0; i < 150; i += 1) tick(internals, now)
  assert(
    game.currentTurn >= 100,
    `turns must execute continuously, got ${game.currentTurn}`,
  )
  assert(
    world.tick >= 1500,
    `sim steps must advance with the turns, got tick ${world.tick}`,
  )
  const stalls = statusLog.filter((m) => m !== null)
  assertEqual(stalls.length, 0, 'no stall surfaces during healthy play')
})

test('surrender queued mid-match executes and ends the match', () => {
  let endCount = 0
  let endWon: boolean | null = null
  const { game, world, internals } = makeGame((won) => {
    endCount += 1
    endWon = won
  })
  const now = { ms: 1000 }
  for (let i = 0; i < 30; i += 1) tick(internals, now)
  assert(game.currentTurn >= 25, `match is live, turn ${game.currentTurn}`)
  game.surrender()
  for (let i = 0; i < 20 && endCount === 0; i += 1) tick(internals, now)
  assertEqual(endCount, 1, 'match end fires exactly once')
  assertEqual(endWon, false, 'the surrendering player loses')
  assertEqual(world.winner, 1, 'opponent is the winner after a surrender')
})

test('a stalled practice match surfaces status, cleared when turns flow', () => {
  const { statusLog, internals } = makeGame()
  // No thinkAi: player 1's bundles never arrive, so the peer stalls.
  internals.peer.pump(1000) // primes the progress clock
  internals.peer.pump(1000 + 2500) // waited past stallWarnMs -> onStall
  const shown = statusLog.filter((m) => m !== null)
  assertEqual(shown.length, 1, 'stall is surfaced to the player exactly once')
  assert(shown[0]!.includes('stalled'), `stall message reads: ${shown[0]}`)
  // The AI bundle for turn 0 arrives; the turn executes; status clears.
  internals.thinkAi()
  internals.peer.pump(1000 + 2750)
  assertEqual(
    statusLog[statusLog.length - 1],
    null,
    'status clears when turns flow again',
  )
})
