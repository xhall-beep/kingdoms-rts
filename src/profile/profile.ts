/**
 * Persistent kingdom profile — localStorage-backed meta-progression.
 *
 * This module is entirely outside the deterministic sim state: it never
 * touches World, systems, or the FNV-1a hash. It only reads/writes
 * localStorage and returns plain data objects.
 */

export const PROFILE_VERSION = 1
export const STORAGE_KEY = 'kingdoms-profile-v1'
const DEFAULT_KINGDOM_NAME = 'My Kingdom'
const NAME_MAX_LENGTH = 24

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

export interface Profile {
  version: 1
  kingdomName: string
  createdAt: string
  campaignProgress: CampaignProgress
  unlockedFactions: string[]
  unlockedBuildings: string[]
  stats: ProfileStats
  ratings: ProfileRatings
}

/** Trim, cap at 24 chars, fall back to a default when empty. */
export function sanitizeKingdomName(name: string): string {
  const trimmed = name.trim().slice(0, NAME_MAX_LENGTH)
  return trimmed.length > 0 ? trimmed : DEFAULT_KINGDOM_NAME
}

export function createDefaultProfile(name: string): Profile {
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
  if (typeof p.stats !== 'object' || p.stats === null) return false
  return true
}

/**
 * Load the profile from localStorage. Never throws — returns a default
 * profile on missing key, corrupt JSON, version mismatch, or wrong shape.
 */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createDefaultProfile('')
    const data = JSON.parse(raw)
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
