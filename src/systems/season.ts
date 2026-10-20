import type { System, World } from '../core/World.ts'
import { bellRung } from './bells.ts'

/**
 * The Season Wheel — the mid-match biome turn (v2.0 spec).
 *
 * When the Second Bell rings (6:00), the season turns to winter: snow
 * covers the field and every unit's stride slows. The turn is a pure
 * function of the bell state, so it is deterministic under lockstep and
 * is recorded in hashed sim state (world.season).
 *
 * Frozen rivers becoming crossable paths arrive with river terrain —
 * the map data has no rivers yet, so the snow slowdown is the whole
 * mechanical effect for now.
 */
export const SEASON_GROWING = 0
export const SEASON_WINTER = 1

/** Movement multiplier while snow is on the ground. */
export const WINTER_SPEED_MULT = 0.75

export class SeasonSystemImpl implements System {
  update(world: World): void {
    if (world.season === SEASON_GROWING && bellRung(world, 1)) {
      world.season = SEASON_WINTER
    }
  }
}

/** Movement multiplier for the current season (1 = clear ground). */
export function seasonSpeedMult(world: World): number {
  return world.season === SEASON_WINTER ? WINTER_SPEED_MULT : 1
}
