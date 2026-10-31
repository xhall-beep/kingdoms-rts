import type { UnitType } from './units.ts';

/**
 * Factions: look (for the future renderer), names, and gameplay modifiers.
 * Modifiers are multipliers applied on top of the shared unit tables in units.ts, so factions differ
 * in feel without needing separate stat sheets. Tune them with `npm run balance`.
 */
export type FactionId =
  | 'human'
  | 'elf'
  | 'goblin'
  | 'dwarf'
  | 'orc'
  | 'undead'
  | 'lich'
  | 'beastkin'
  | 'wild'
  | 'minotaur'
  | 'fae'
  | 'angelic'
  | 'demon'
  | 'elemental'
  | 'construct'
  | 'lizardfolk'
  | 'spiderfolk'
  | 'halfling'
  | 'gnome'
  | 'tiefling';

export interface Modifiers {
  hp: number;      // Unit hit points.
  damage: number;  // Unit attack damage.
  speed: number;   // Unit movement speed.
  cost: number;    // Unit cost (lower = cheaper).
  train: number;   // Unit training time (lower = faster).
  gather: number;  // Worker harvesting speed.
}

/**
 * Faction signature mechanic — the unique system that defines how a faction
 * plays differently, beyond stat multipliers. Data-driven; systems check
 * for the presence of each signature key.
 */
export interface FactionSignature {
  /** Undead reanimation: fallen units may rise as temporary skeletons. */
  reanimate?: { chance: number; hpFactor: number; durationSec: number };
  /** Orc momentum: damage bonus building while in sustained combat. */
  momentum?: { damagePerSec: number; maxBonus: number; resetSec: number };
  /** Elf woodland: speed and range bonuses near trees. */
  woodland?: { speedBonus: number; rangeBonus: number; treeRadius: number };
  /** Human adaptability: cheaper upgrades. */
  adaptable?: { upgradeCostFactor: number };
  // Future signatures: woodlandSpeed, scavenging, auras, etc.
}

export interface FactionDef {
  name: string;
  colors: [number, number, number]; // primary, secondary, accent
  skin: number;
  head: 'helm' | 'ears' | 'hood' | 'horns';
  beard?: number;
  hall: string;                      // Town Hall model recipe: "base,roof,extra,extra"
  units: Record<UnitType, string>;   // Display names
  mods: Modifiers;
  signature?: FactionSignature;
  worker: WorkerDef;
}

/**
 * Racial worker identity — how each faction's worker gathers and builds.
 * The four founding races have true mechanical asymmetry; other factions
 * use the standard worker profile.
 */
export interface WorkerDef {
  /** Max carried resources before returning (Drudge: 20, others: 10). */
  carryMax: number;
  /** Construction speed multiplier (Human co-op edge: 1.15). */
  buildRate: number;
  /** Undead seed-warp: the Husk plants the seed and walks away; the
   *  structure pulls itself up from the earth on its own. */
  seedWarp: boolean;
  /** Elf symbiotic harvest: tapping trees for sap never depletes them. */
  sapTap: boolean;
}

/** Standard worker profile for factions without a unique labor identity. */
const STANDARD_WORKER: WorkerDef = { carryMax: 10, buildRate: 1, seedWarp: false, sapTap: false };

/** Order matches Modifiers: hp, damage, speed, cost, train, gather. */
const m = (hp: number, damage: number, speed: number, cost: number, train: number, gather: number): Modifiers =>
  ({ hp, damage, speed, cost, train, gather });

export const FACTIONS: Record<FactionId, FactionDef> = {
  human: { name: 'Human', colors: [0x2f6fd6, 0xf5c542, 0xdfe8f5], skin: 0xf2c9a0, head: 'helm', hall: 'box,pyr,towers,banner',
    units: { worker: 'Peasant', melee: 'Footman', ranged: 'Longbowman' },
    mods: m(1, 1, 1, 1, 1, 1),
    signature: { adaptable: { upgradeCostFactor: 0.8 } },
    worker: { carryMax: 10, buildRate: 1.15, seedWarp: false, sapTap: false } },
  elf: { name: 'Elf', colors: [0x2e9e57, 0xe8d27a, 0xcff5b0], skin: 0xf6d8b8, head: 'ears', hall: 'round,cone,spires,tree',
    units: { worker: 'Gatherer', melee: 'Sentinel', ranged: 'Moon Archer' },
    mods: m(0.9, 1.1, 1.1, 1.05, 1, 1),
    signature: { woodland: { speedBonus: 0.25, rangeBonus: 1.0, treeRadius: 8 } },
    worker: { carryMax: 10, buildRate: 1, seedWarp: false, sapTap: true } },
  goblin: { name: 'Goblin', colors: [0x7a3b2e, 0xc9372c, 0x2b2b2b], skin: 0x8cc43c, head: 'ears', hall: 'box,pyr,horns,skull',
    units: { worker: 'Scavenger', melee: 'Spearman', ranged: 'Slinger' },
    mods: m(0.85, 0.95, 1.1, 0.85, 0.85, 1),
    worker: STANDARD_WORKER },
  dwarf: { name: 'Dwarf', colors: [0x8a5a2b, 0x9aa7b8, 0xf0a03c], skin: 0xe8b48a, head: 'helm', beard: 0xd9602b, hall: 'box,flat,towers,chimney',
    units: { worker: 'Miner', melee: 'Shieldbearer', ranged: 'Crossbow' },
    mods: m(1.2, 1.05, 0.94, 1, 1.02, 1.05),
    worker: STANDARD_WORKER },
  orc: { name: 'Orc', colors: [0x8a2b22, 0xc9372c, 0x3a2a22], skin: 0x7da63a, head: 'horns', hall: 'box,pyr,horns,towers',
    units: { worker: 'Drudge', melee: 'Mauler', ranged: 'Javelineer' },
    mods: m(1.15, 1.15, 0.95, 1.1, 1.1, 0.9),
    signature: { momentum: { damagePerSec: 0.02, maxBonus: 0.3, resetSec: 5 } },
    worker: { carryMax: 20, buildRate: 1, seedWarp: false, sapTap: false } },
  undead: { name: 'Undead', colors: [0x5b3f8f, 0x9be7ff, 0x2a2236], skin: 0xe9e4d4, head: 'hood', hall: 'box,cone,spires,skull',
    units: { worker: 'Husk', melee: 'Gnawer', ranged: 'Gloom Archer' },
    mods: m(0.9, 0.95, 0.95, 1, 1, 0.9),
    signature: { reanimate: { chance: 0.25, hpFactor: 0.5, durationSec: 15 } },
    worker: { carryMax: 10, buildRate: 1, seedWarp: true, sapTap: false } },
  lich: { name: 'Lich', colors: [0x1d6f8f, 0x7ff0ff, 0x1a1f2e], skin: 0xdfe8e4, head: 'hood', hall: 'round,cone,crystals,spires',
    units: { worker: 'Soul Harvester', melee: 'Death Knight', ranged: 'Necromancer' },
    mods: m(0.85, 1.2, 1, 1.1, 1.05, 0.95),
    worker: STANDARD_WORKER },
  beastkin: { name: 'Beastkin', colors: [0x7a5b3a, 0x4fb3e8, 0xd9d2c0], skin: 0xa88f78, head: 'ears', hall: 'box,pyr,horns,banner',
    units: { worker: 'Tracker', melee: 'Claw Warrior', ranged: 'Hunter' },
    mods: m(1, 1.05, 1.12, 1, 0.95, 0.9),
    worker: STANDARD_WORKER },
  wild: { name: 'Wild', colors: [0x5f8a34, 0xb5651d, 0x3d5a1e], skin: 0xc59a6a, head: 'horns', hall: 'round,leaf,tree,horns',
    units: { worker: 'Gatherer', melee: 'Stag Guard', ranged: 'Hunter' },
    mods: m(1.05, 0.95, 1.05, 0.95, 1, 1.05),
    worker: STANDARD_WORKER },
  minotaur: { name: 'Minotaur', colors: [0x7a3a1e, 0xe8a13c, 0x4a4a4a], skin: 0xa0602f, head: 'horns', hall: 'box,flat,horns,banner',
    units: { worker: 'Harvester', melee: 'Maulbearer', ranged: 'Spear Thrower' },
    mods: m(1.3, 1.15, 0.95, 1.05, 1.05, 0.9),
    worker: STANDARD_WORKER },
  fae: { name: 'Fae', colors: [0x8e4fc7, 0xf59ad0, 0x7ff0ff], skin: 0xf3d3e8, head: 'ears', hall: 'round,cone,wings,crystals',
    units: { worker: 'Pixie', melee: 'Thorn Guard', ranged: 'Spellweaver' },
    mods: m(0.85, 1.1, 1.15, 1, 0.9, 1.1),
    worker: STANDARD_WORKER },
  angelic: { name: 'Angelic', colors: [0xe9d27a, 0xffffff, 0x3a73d6], skin: 0xf8e0c8, head: 'helm', hall: 'box,cone,wings,spires',
    units: { worker: 'Seraph', melee: 'Paladin', ranged: 'Lightbringer' },
    mods: m(1.1, 1.1, 1, 1.1, 1.05, 0.95),
    worker: STANDARD_WORKER },
  demon: { name: 'Demon', colors: [0xa8261e, 0xff8a3d, 0x2a1414], skin: 0xd8453a, head: 'horns', hall: 'box,pyr,horns,spires',
    units: { worker: 'Imp', melee: 'Hellblade', ranged: 'Fire Caster' },
    mods: m(1.05, 1.25, 1, 1.1, 1.05, 0.85),
    worker: STANDARD_WORKER },
  elemental: { name: 'Elemental', colors: [0x2f8fe8, 0x9be7ff, 0xffffff], skin: 0x7fc8ff, head: 'horns', hall: 'round,crystals,crystals,banner',
    units: { worker: 'Aether', melee: 'Stone Guard', ranged: 'Shard Caster' },
    mods: m(1, 1.15, 1.05, 1.1, 1.05, 1),
    worker: STANDARD_WORKER },
  construct: { name: 'Construct', colors: [0x6b6f7a, 0x3ec6ff, 0xb08d3a], skin: 0x9aa0aa, head: 'helm', hall: 'box,flat,towers,chimney',
    units: { worker: 'Servitor', melee: 'Golem', ranged: 'Cannoneer' },
    mods: m(1.25, 0.95, 0.85, 1, 1.1, 1.1),
    worker: STANDARD_WORKER },
  lizardfolk: { name: 'Lizardfolk', colors: [0x1f8f9e, 0xf0c53c, 0x2f5f8f], skin: 0x3fb5a8, head: 'horns', hall: 'round,dome,horns,banner',
    units: { worker: 'Scaler', melee: 'Spearman', ranged: 'Dart Thrower' },
    mods: m(1, 1, 1, 1, 1, 1.05),
    worker: STANDARD_WORKER },
  spiderfolk: { name: 'Spiderfolk', colors: [0x2a1f33, 0xd8302f, 0x6a3b8f], skin: 0x3a2f40, head: 'horns', hall: 'round,dome,legs,spires',
    units: { worker: 'Spinner', melee: 'Fangblade', ranged: 'Web Spitter' },
    mods: m(0.9, 1.1, 1.05, 0.95, 0.9, 0.95),
    worker: STANDARD_WORKER },
  halfling: { name: 'Halfling', colors: [0x4a7a3a, 0xb5651d, 0xe8d27a], skin: 0xf2c9a0, head: 'hood', hall: 'cot,leaf,chimney,tree',
    units: { worker: 'Gardener', melee: 'Dagger Hand', ranged: 'Slinger' },
    mods: m(0.85, 0.9, 1, 0.8, 0.8, 1.3),
    worker: STANDARD_WORKER },
  gnome: { name: 'Gnome', colors: [0xc23a2e, 0xb08d3a, 0x4f9ddd], skin: 0xf2c9a0, head: 'hood', hall: 'round,dome,tele,chimney',
    units: { worker: 'Tinkerer', melee: 'Bomber', ranged: 'Crossbow' },
    mods: m(0.9, 1.05, 1, 0.9, 0.9, 1.2),
    worker: STANDARD_WORKER },
  tiefling: { name: 'Tiefling', colors: [0x6a2a8f, 0xff7a3d, 0x2a1a3a], skin: 0x9a5fc2, head: 'horns', hall: 'box,cone,horns,spires',
    units: { worker: 'Emberling', melee: 'Hexblade', ranged: 'Pyromancer' },
    mods: m(0.95, 1.15, 1.05, 1, 0.95, 1),
    worker: STANDARD_WORKER },
};

export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];
