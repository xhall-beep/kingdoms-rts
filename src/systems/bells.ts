import type { System, World } from '../core/World.ts'

/**
 * The Three Bells — the match clock made audible (v2.0 spec, section 4).
 *
 *   First Bell  (3:00): the quiet opening ends; the raid phase begins. The
 *     first probe follows once the AI's opening advance floor passes
 *     (225s/240s by personality — OPENING_ADVANCE_DELAY_SEC in opponent.ts).
 *   Second Bell (6:00): the Season Wheel turns; Elder Vaults unseal.
 *   Third Bell  (9:00): Tier 3 unlocks; Divine Creatures unleash; mines collapse.
 *
 * This system only rings and records. Each bell's *effects* live in the
 * systems that own them (AI reads bellsRung[0]; seasons will read [1];
 * late-game unlocks will read [2]). Ringing is a pure function of matchTime,
 * so it is deterministic under lockstep.
 */
export const BELL_TIMES = [180, 360, 540] as const
export const BELL_NAMES = ['First Bell — the Raid Bell', 'Second Bell — the Turn', 'Third Bell — the War Bell'] as const

/**
 * The opening grace (softening slice, 2026-11-21): until the First Bell
 * the match's offensive systems hold — the Living Wild does not answer
 * a harvest and the AI sends no shrine sorties, while its first march
 * waits on the longer advance floor in opponent.ts. Defense is never
 * part of the grace: a force attacked in the window fights back at
 * full strength. One boundary, shared by every system that keys on
 * it, so the quiet opening cannot drift apart between owners.
 */
export const OPENING_GRACE_SEC = BELL_TIMES[0]

/**
 * The forest's grace runs one bell longer, to the Second Bell
 * (persona proving, 2026-11-21): a treant rising at the First Bell is
 * still a first-minutes killer for any build whose first soldiers
 * come after 3:00 — the Economist's boom died to the 3:00 treant with
 * zero soldiers fielded, exactly as it had to the 1:37 treant before
 * the slice — and it synchronizes with a rusher's departure, eating
 * the wood line the moment the army leaves. The AI's own grace
 * (sorties, marches) stays at the First Bell above; the wild is not
 * the AI, and A3's full-strength deadline binds the AI, not the
 * forest. At the Second Bell the shipped game itself escalates, and
 * a build with no soldiers by 6:00 is behind on its own terms.
 */
export const WILD_GRACE_SEC = BELL_TIMES[1]

export class BellSystemImpl implements System {
  update(world: World): void {
    for (let i = 0; i < BELL_TIMES.length; i += 1) {
      if (world.bellsRung[i] === 0 && world.matchTime >= BELL_TIMES[i]) {
        world.bellsRung[i] = 1
      }
    }
  }
}

/** True once the given bell (0, 1, 2) has rung. */
export function bellRung(world: World, bell: 0 | 1 | 2): boolean {
  return world.bellsRung[bell] === 1
}
