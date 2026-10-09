import type { ResourceKind } from '../core/types.ts';

/** Harvestable nodes. `radius` is the obstacle size used for pathing. */
export const RESOURCES: Record<ResourceKind, { amount: number; radius: number }> = {
  wood: { amount: 100, radius: 1.3 },
  gold: { amount: 800, radius: 2.0 },
};
