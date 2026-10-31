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
