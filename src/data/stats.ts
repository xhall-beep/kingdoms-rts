/**
 * Stats provider — swappable stat tables for game modes.
 *
 * Default: base stats (campaign, progression, custom games).
 * Standard Battle: tournament stats (fixed, symmetric, skill-only).
 *
 * All game systems should read stats via getUnits() rather than importing
 * UNITS directly, so mode switches apply everywhere atomically.
 */
import { UNITS } from './units.ts'
import type { UnitDef, UnitType } from './units.ts'
import { STANDARD_UNITS } from './standard.ts'

export type StatsMode = 'base' | 'standard'

let mode: StatsMode = 'base'

/** Active unit stat table for the current game mode. */
export function getUnits(): Record<UnitType, UnitDef> {
  return mode === 'standard' ? STANDARD_UNITS : UNITS
}

/** Switch the active stat table. Call on mode transitions. */
export function setStatsMode(next: StatsMode): void {
  mode = next
}

/** Current stats mode (for debugging and replay metadata). */
export function getStatsMode(): StatsMode {
  return mode
}
