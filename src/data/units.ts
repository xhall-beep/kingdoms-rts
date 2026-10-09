import type { Resources } from '../core/types.ts';
import { TICK_RATE, secondsToTicks as ticks } from '../core/time.ts';

export type UnitType = 'worker' | 'melee' | 'ranged';

export interface UnitDef {
  cost: Resources;
  hp: number;
  damage: number;
  range: number;         // World units; measured to the target's edge.
  sight: number;         // World units; how far the unit notices enemies.
  speed: number;         // World units per tick.
  cooldownTicks: number; // Ticks between strikes (attack speed).
  trainTicks: number;    // Ticks to produce.
  popCost: number;       // Population used while alive or queued.
}

export const UNITS: Record<UnitType, UnitDef> = {
  worker: { cost: { gold: 50, wood: 0 }, hp: 60, damage: 4, range: 1.8, sight: 10, speed: 5 / TICK_RATE, cooldownTicks: ticks(0.8), trainTicks: ticks(5), popCost: 1 },
  melee: { cost: { gold: 100, wood: 30 }, hp: 170, damage: 18, range: 2.1, sight: 14, speed: 4.4 / TICK_RATE, cooldownTicks: ticks(0.8), trainTicks: ticks(8), popCost: 2 },
  ranged: { cost: { gold: 80, wood: 50 }, hp: 85, damage: 12, range: 11, sight: 14, speed: 4.8 / TICK_RATE, cooldownTicks: ticks(1.1), trainTicks: ticks(7), popCost: 1 },
};
