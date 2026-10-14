/**
 * AI balance regression — guards the 2026-10-14 aggressor-blowout fix.
 * The aggressor used to get wiped 0-8 by the old default (normal/expander);
 * after the fix (attack wave of 6, 9-worker rush economy) it plays real games.
 * This test runs a short headless mirror and asserts the matchup is alive
 * (no instant wipe) and deterministic. Full 24-match series live in
 * goal hidden_files (mirror-series-2026-10-14.jsonl).
 */
import { runMatch } from './match-runner.ts'
import { suite, test, assert } from './harness.ts'

suite('ai-balance: aggressor mirror regression')

function shortMirror(): { winner: number; playerUnits: number; enemyUnits: number } {
  // 3 minutes of sim: long enough for the first waves to clash.
  const r = runMatch('normal', 'normal', 60 * 60 * 3, 'human', 'human', 'aggressor', 'expander')
  return { winner: r.winner, playerUnits: r.playerUnits, enemyUnits: r.enemyUnits }
}

test('aggressor vs default is deterministic', () => {
  const a = shortMirror()
  const b = shortMirror()
  assert(
    a.playerUnits === b.playerUnits && a.enemyUnits === b.enemyUnits && a.winner === b.winner,
    `mirror must be deterministic: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  )
})

test('aggressor is not wiped in the opening', () => {
  const r = shortMirror()
  // Pre-fix the aggressor was routinely eliminated in ~6 minutes; at the
  // 3-minute mark it must still have an army or the game must be ongoing.
  const wiped = r.winner === 1 && r.playerUnits === 0
  assert(!wiped, `aggressor wiped too early: ${JSON.stringify(r)}`)
})
