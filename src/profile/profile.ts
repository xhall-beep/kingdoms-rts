/**
 * Persistent kingdom profile — localStorage-backed meta-progression.
 *
 * This module is entirely outside the deterministic sim state: it never
 * touches World, systems, or the FNV-1a hash. It only reads/writes
 * localStorage and returns plain data objects.
 */

export const PROFILE_VERSION = 2
export const STORAGE_KEY = 'kingdoms-profile-v1'
const DEFAULT_KINGDOM_NAME = 'My Kingdom'
const NAME_MAX_LENGTH = 24

/** Default units granted by any unlocked faction (Stage 1 roster). */
const FACTION_DEFAULT_UNITS = ['worker', 'melee', 'ranged'] as const

export interface CampaignProgress {
  completedMissions: string[]
  currentMission: string | null
}

export interface ModeStats {
  wins: number
  losses: number
}

export interface ProfileStats {
  perMode: Record<string, ModeStats>
}

export interface ProfileRatings {
  pvpElo?: number
}

export interface UnitRosterEntry {
  unlocked: boolean
  level: number
}

export interface Profile {
  version: 2
  kingdomName: string
  createdAt: string
  campaignProgress: CampaignProgress
  unlockedFactions: string[]
  unlockedBuildings: string[]
  /** Building type → persistent level (drives power-band matchmaking). */
  buildingLevels: Record<string, number>
  /** Unit type → unlock + persistent level. */
  unitRoster: Record<string, UnitRosterEntry>
  /** Hero id → level (empty until the hero system lands). */
  heroes: Record<string, number>
  /** Tech id → persistent level. */
  techLevels: Record<string, number>
  stats: ProfileStats
  ratings: ProfileRatings
}

/**
 * Progression snapshot as consumed by the PvP matchmaker's hidden
 * Power Score (server/src/power.ts). Built from the profile — never
 * empty when the player has any progression.
 */
export interface ProgressionSnapshot {
  buildings: Record<string, number>
  units: Record<string, { unlocked: boolean; level: number }>
  heroes: Record<string, number>
  tech: Record<string, number>
  army: Record<string, number>
}

/** Trim, cap at 24 chars, fall back to a default when empty. */
export function sanitizeKingdomName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX_LENGTH)
  return trimmed.length > 0 ? trimmed : DEFAULT_KINGDOM_NAME
}

export function createDefaultProfile(name: string): Profile {
  const buildingLevels: Record<string, number> = {}
  for (const b of ['hall', 'farm']) buildingLevels[b] = 1
  const unitRoster: Record<string, UnitRosterEntry> = {}
  for (const u of FACTION_DEFAULT_UNITS) unitRoster[u] = { unlocked: true, level: 1 }
  return {
    version: PROFILE_VERSION,
    kingdomName: sanitizeKingdomName(name),
    createdAt: new Date().toISOString(),
    campaignProgress: {
      completedMissions: [],
      currentMission: null,
    },
    unlockedFactions: ['human'],
    unlockedBuildings: ['hall', 'farm'],
    buildingLevels,
    unitRoster,
    heroes: {},
    techLevels: {},
    stats: { perMode: {} },
    ratings: {},
  }
}

function isValidProfile(data: unknown): data is Profile {
  if (typeof data !== 'object' || data === null) return false
  const p = data as Record<string, unknown>
  if (p.version !== PROFILE_VERSION) return false
  if (typeof p.kingdomName !== 'string') return false
  if (typeof p.createdAt !== 'string') return false
  if (typeof p.campaignProgress !== 'object' || p.campaignProgress === null) return false
  if (!Array.isArray(p.unlockedFactions)) return false
  if (!Array.isArray(p.unlockedBuildings)) return false
  if (typeof p.buildingLevels !== 'object' || p.buildingLevels === null) return false
  if (typeof p.unitRoster !== 'object' || p.unitRoster === null) return false
  if (typeof p.heroes !== 'object' || p.heroes === null) return false
  if (typeof p.techLevels !== 'object' || p.techLevels === null) return false
  if (typeof p.stats !== 'object' || p.stats === null) return false
  return true
}

/** Migrate a v1 profile (no level maps) to v2. */
function migrateV1ToV2(data: Record<string, unknown>): Profile {
  const base = createDefaultProfile(
    typeof data.kingdomName === 'string' ? data.kingdomName : '',
  )
  const migrated: Profile = {
    ...base,
    kingdomName: base.kingdomName,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : base.createdAt,
    campaignProgress:
      typeof data.campaignProgress === 'object' && data.campaignProgress !== null
        ? (data.campaignProgress as Profile['campaignProgress'])
        : base.campaignProgress,
    unlockedFactions: Array.isArray(data.unlockedFactions)
      ? (data.unlockedFactions as string[])
      : base.unlockedFactions,
    unlockedBuildings: Array.isArray(data.unlockedBuildings)
      ? (data.unlockedBuildings as string[])
      : base.unlockedBuildings,
    stats:
      typeof data.stats === 'object' && data.stats !== null
        ? (data.stats as ProfileStats)
        : base.stats,
    ratings:
      typeof data.ratings === 'object' && data.ratings !== null
        ? (data.ratings as ProfileRatings)
        : base.ratings,
  }
  // Derive level maps from the v1 unlock lists.
  for (const b of migrated.unlockedBuildings) {
    if (!(b in migrated.buildingLevels)) migrated.buildingLevels[b] = 1
  }
  for (const f of migrated.unlockedFactions) {
    void f
    for (const u of FACTION_DEFAULT_UNITS) {
      if (!(u in migrated.unitRoster)) migrated.unitRoster[u] = { unlocked: true, level: 1 }
    }
  }
  return migrated
}

/**
 * Load the profile from localStorage. Never throws — returns a default
 * profile on missing key, corrupt JSON, or wrong shape. v1 profiles are
 * migrated to v2 in memory (persisted on next save).
 */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createDefaultProfile('')
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return createDefaultProfile('')
    const version = (data as Record<string, unknown>).version
    if (version === 1) return migrateV1ToV2(data as Record<string, unknown>)
    if (!isValidProfile(data)) return createDefaultProfile('')
    return data
  } catch {
    return createDefaultProfile('')
  }
}

/** Save the profile to localStorage. Returns false if storage is unavailable. */
export function saveProfile(profile: Profile): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
    return true
  } catch {
    return false
  }
}

/** Remove the profile from localStorage. */
export function clearProfile(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/** Returns the profile with the match result recorded for the given mode. */
export function recordMatchResult(profile: Profile, mode: string, won: boolean): Profile {
  const stats = profile.stats.perMode[mode] ?? { wins: 0, losses: 0 }
  if (won) stats.wins += 1
  else stats.losses += 1
  return {
    ...profile,
    stats: {
      perMode: { ...profile.stats.perMode, [mode]: stats },
    },
  }
}

/** Unlock a building type at level 1 (idempotent). */
export function unlockBuilding(profile: Profile, type: string): Profile {
  if (profile.unlockedBuildings.includes(type)) return profile
  return {
    ...profile,
    unlockedBuildings: [...profile.unlockedBuildings, type],
    buildingLevels: { ...profile.buildingLevels, [type]: 1 },
  }
}

/** Set a building's persistent level (unlocks it if new). */
export function setBuildingLevel(profile: Profile, type: string, level: number): Profile {
  const lvl = Math.max(1, Math.floor(level))
  return {
    ...profile,
    unlockedBuildings: profile.unlockedBuildings.includes(type)
      ? profile.unlockedBuildings
      : [...profile.unlockedBuildings, type],
    buildingLevels: { ...profile.buildingLevels, [type]: lvl },
  }
}

/** Unlock a faction and grant its default units (idempotent). */
export function unlockFaction(profile: Profile, factionId: string): Profile {
  const unitRoster = { ...profile.unitRoster }
  for (const u of FACTION_DEFAULT_UNITS) {
    if (!(u in unitRoster)) unitRoster[u] = { unlocked: true, level: 1 }
  }
  if (profile.unlockedFactions.includes(factionId)) return { ...profile, unitRoster }
  return {
    ...profile,
    unlockedFactions: [...profile.unlockedFactions, factionId],
    unitRoster,
  }
}

/** Set a unit's persistent level (marks unlocked). */
export function setUnitLevel(profile: Profile, unitType: string, level: number): Profile {
  return {
    ...profile,
    unitRoster: {
      ...profile.unitRoster,
      [unitType]: { unlocked: true, level: Math.max(1, Math.floor(level)) },
    },
  }
}

/** Set a hero's level (0 or less removes the hero). */
export function setHeroLevel(profile: Profile, heroId: string, level: number): Profile {
  const heroes = { ...profile.heroes }
  if (level <= 0) delete heroes[heroId]
  else heroes[heroId] = Math.floor(level)
  return { ...profile, heroes }
}

/** Set a tech's persistent level (0 or less removes it). */
export function setTechLevel(profile: Profile, techId: string, level: number): Profile {
  const techLevels = { ...profile.techLevels }
  if (level <= 0) delete techLevels[techId]
  else techLevels[techId] = Math.floor(level)
  return { ...profile, techLevels }
}

/**
 * Build the matchmaker progression snapshot from the profile.
 * `army` is the standing army (unit type → count); empty when queueing
 * from the menu with no active game. Shape matches the server's
 * ProgressionSnapshot (worker/src/power.ts).
 */
export function buildProgressionSnapshot(
  profile: Profile,
  army: Record<string, number> = {},
): ProgressionSnapshot {
  return {
    buildings: { ...profile.buildingLevels },
    units: Object.fromEntries(
      Object.entries(profile.unitRoster).map(([k, v]) => [k, { ...v }]),
    ),
    heroes: { ...profile.heroes },
    tech: { ...profile.techLevels },
    army: { ...army },
  }
}
