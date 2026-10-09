/**
 * Shared primitive types for game data.
 * Seed of the full ECS component registry in the sim
 * (ref/kingdoms-sim/src/core/types.ts) — grow this file when porting the
 * simulation core (blueprint step 2).
 */
export type ResourceKind = 'wood' | 'gold';

export interface Resources { gold: number; wood: number }

export interface Vec2 { x: number; z: number }
