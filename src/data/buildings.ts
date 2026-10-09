import type { Resources } from '../core/types.ts';
import { secondsToTicks as ticks } from '../core/time.ts';
import type { UnitType } from './units.ts';

export type BuildingType = 'hall' | 'barracks' | 'archery' | 'farm';

export interface BuildingDef {
  name: string;
  cost: Resources;
  hp: number;
  radius: number;      // Footprint radius: blocks pathing and sets attack reach.
  buildTicks: number;  // Worker-ticks of construction needed.
  trains: UnitType[];  // Empty = no production queue.
  supply: number;      // Population capacity provided once built.
  sight: number;       // Vision radius once built (world units).
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  hall: { name: 'Town Hall', cost: { gold: 350, wood: 150 }, hp: 1500, radius: 5.2, buildTicks: ticks(14), trains: ['worker'], supply: 10, sight: 24 },
  barracks: { name: 'Barracks', cost: { gold: 150, wood: 110 }, hp: 850, radius: 3.9, buildTicks: ticks(10), trains: ['melee'], supply: 0, sight: 16 },
  archery: { name: 'Archery Range', cost: { gold: 170, wood: 130 }, hp: 700, radius: 3.6, buildTicks: ticks(10), trains: ['ranged'], supply: 0, sight: 16 },
  farm: { name: 'Farm', cost: { gold: 50, wood: 80 }, hp: 380, radius: 3, buildTicks: ticks(6), trains: [], supply: 6, sight: 10 },
};
