import type { Resources } from '../core/types.ts';
import { secondsToTicks as ticks } from '../core/time.ts';
import type { UnitType } from './units.ts';

export type BuildingType = 'hall' | 'barracks' | 'archery' | 'farm' | 'tower' | 'workshop' | 'smithy';

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
  hall: { name: 'Town Hall', cost: { gold: 350, wood: 150 }, hp: 1500, radius: 5.2, buildTicks: ticks(14), trains: ['worker'], supply: 10, sight: 42 },
  barracks: { name: 'Barracks', cost: { gold: 150, wood: 110 }, hp: 850, radius: 3.9, buildTicks: ticks(10), trains: ['melee', 'ranged'], supply: 0, sight: 28 },
  archery: { name: 'Archery Range', cost: { gold: 170, wood: 130 }, hp: 700, radius: 3.6, buildTicks: ticks(10), trains: [], supply: 0, sight: 28 },
  farm: { name: 'Farm', cost: { gold: 50, wood: 80 }, hp: 380, radius: 3, buildTicks: ticks(6), trains: [], supply: 6, sight: 18 },
  tower: { name: 'Guard Tower', cost: { gold: 100, wood: 50 }, hp: 600, radius: 2.5, buildTicks: ticks(8), trains: [], supply: 0, sight: 34 },
  // Tech buildings (Montz directive 2026-10-26): upgrades no longer come
  // free with the barracks. The Workshop is the tech root — Smithy and
  // Archery Range placements require a finished one (construction.ts) —
  // and the Smithy hosts the melee research ladders. The Range trains
  // nothing itself; it unlocks ranged training at the Barracks and hosts
  // the ranged ladder.
  workshop: { name: 'Workshop', cost: { gold: 120, wood: 100 }, hp: 650, radius: 3.4, buildTicks: ticks(9), trains: [], supply: 0, sight: 24 },
  smithy: { name: 'Smithy', cost: { gold: 160, wood: 120 }, hp: 750, radius: 3.6, buildTicks: ticks(10), trains: [], supply: 0, sight: 24 },
};

/**
 * Supply granted by an undead hall — higher than the shared hall grant (10)
 * because it is undead's ONLY pre-combat supply: undead raise no farms, and
 * Soul-Ash grows the cap only through corpses. At the shared 10 the early
 * pop math cannot close (army-ceiling audit 2026-10-22): the AI's 4-supply
 * army reserve clamps workers to 6, and the 4 reserve pop fields exactly
 * 3 soldiers (1 melee + 2 ranged) — below every attack gate, so undead
 * could never start the combat its economy runs on.
 *
 * At 18 the cold-start math closes for every personality, with no corpses:
 * a full worker line (aggressor 9 / normal·defender 10 / expander 12)
 * plus 6–9 pop of soldiers — 4–5 soldiers, enough to satisfy undead's
 * lowered attack threshold (3 available) even keeping a garrison. A
 * farm faction passes 18 only with a hall plus two farms (10+6+6=22);
 * undead's static 18 still waits on corpses for any further growth.
 */
export const UNDEAD_HALL_SUPPLY = 18;

/**
 * Supply a completed building of this type grants its owner. Faction-aware
 * (the undead hall above); every other grant is the shared table value.
 * All supply accounting — spawn, construction completion, destruction —
 * must go through here so grants and removals always agree.
 */
export function buildingSupply(type: BuildingType, faction: string): number {
  if (type === 'hall' && faction === 'undead') return UNDEAD_HALL_SUPPLY;
  return BUILDINGS[type].supply;
}
