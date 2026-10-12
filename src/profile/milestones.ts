/**
 * Progression milestones — wins grant persistent unlocks.
 *
 * Meta-only: runs in the UI layer after a recorded match result, never
 * in sim tick code. Unlocks feed the persistent profile and the PvP
 * power snapshot; they never alter the deterministic sim.
 */
import {
  type Profile,
  setBuildingLevel,
  unlockBuilding,
} from './profile.ts'

export interface Milestone {
  id: string
  description: string
  /** Total wins (any mode) required. */
  winsRequired: number
  apply: (profile: Profile) => Profile
  /** Human-readable reward label for the unlock toast. */
  rewardLabel: string
}

export const MILESTONES: Milestone[] = [
  {
    id: 'first-blood',
    description: 'Win your first battle',
    winsRequired: 1,
    apply: (p) => unlockBuilding(p, 'barracks'),
    rewardLabel: 'Barracks unlocked',
  },
  {
    id: 'veteran',
    description: 'Win 3 battles',
    winsRequired: 3,
    apply: (p) => unlockBuilding(p, 'archery'),
    rewardLabel: 'Archery Range unlocked',
  },
  {
    id: 'siegebreaker',
    description: 'Win 5 battles',
    winsRequired: 5,
    apply: (p) => unlockBuilding(p, 'tower'),
    rewardLabel: 'Guard Tower unlocked',
  },
  {
    id: 'stronghold',
    description: 'Win 10 battles',
    winsRequired: 10,
    apply: (p) => setBuildingLevel(p, 'hall', 2),
    rewardLabel: 'Town Hall upgraded to level 2',
  },
]

function totalWins(profile: Profile): number {
  return Object.values(profile.stats.perMode).reduce((sum, m) => sum + m.wins, 0)
}

function isMilestoneClaimed(profile: Profile, id: string): boolean {
  return profile.campaignProgress.completedMissions.includes(`milestone:${id}`)
}

function markMilestoneClaimed(profile: Profile, id: string): Profile {
  return {
    ...profile,
    campaignProgress: {
      ...profile.campaignProgress,
      completedMissions: [...profile.campaignProgress.completedMissions, `milestone:${id}`],
    },
  }
}

/**
 * Check all milestones against the profile. Returns the updated profile
 * plus labels for newly claimed rewards (for the unlock toast).
 */
export function checkMilestones(profile: Profile): { profile: Profile; unlocked: string[] } {
  const wins = totalWins(profile)
  const unlocked: string[] = []
  let p = profile
  for (const m of MILESTONES) {
    if (wins >= m.winsRequired && !isMilestoneClaimed(p, m.id)) {
      p = m.apply(p)
      p = markMilestoneClaimed(p, m.id)
      unlocked.push(m.rewardLabel)
    }
  }
  return { profile: p, unlocked }
}
