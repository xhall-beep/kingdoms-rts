/**
 * Standard Battle tournament stats (Clash Royale "Tournament Rules" pattern).
 *
 * In Standard Battle mode, ALL units and buildings use these fixed values,
 * regardless of any player progression, unlocks, or upgrades. This guarantees
 * symmetric, skill-only competition.
 *
 * Values start as the balanced baseline (verified via AI-vs-AI sims).
 * Tune here for competitive balance without affecting campaign/progression.
 */
import type { UnitDef, UnitType } from './units.ts'
import { UNITS } from './units.ts'

export const STANDARD_UNITS: Record<UnitType, UnitDef> = {
  worker: { ...UNITS.worker },
  melee: { ...UNITS.melee },
  ranged: { ...UNITS.ranged },
}

/** Standard Battle ruleset identifier for matchmaking and replays. */
export const STANDARD_RULESET = 'standard-v1'
