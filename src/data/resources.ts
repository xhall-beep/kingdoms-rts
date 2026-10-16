import type { ResourceKind } from '../core/types.ts';

/** Harvestable nodes. `radius` is the obstacle size used for pathing. */
export const RESOURCES: Record<ResourceKind, { amount: number; radius: number }> = {
  wood: { amount: 150, radius: 1.3 },
  // 1600/mine (8 mines = 12,800 total): the 800/mine economy exhausted all
  // gold by ~9 min, deadlocking longer games into 20-min timeouts once both
  // sides fielded real armies. Verified by the 2026-10-16 mirror series.
  gold: { amount: 1600, radius: 2.0 },
};
