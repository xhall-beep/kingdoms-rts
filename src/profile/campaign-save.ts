/**
 * Campaign snapshot save/continue (localStorage).
 *
 * Meta-only persistence: wraps an opaque snapshot string produced by the
 * existing save-load serialization. Never touches sim state, tick logic,
 * or the FNV-1a hash.
 */

export const CAMPAIGN_SAVE_KEY = 'kingdoms-campaign-save-v1'
export const CAMPAIGN_SAVE_VERSION = 1

export interface CampaignSave {
  version: number
  /** Game mode the snapshot was taken in (e.g. 'campaign'). */
  mode: string
  /** Mission/scenario identifier, if applicable. */
  mission: string | null
  /** ISO timestamp of when the save was written. */
  savedAt: string
  /** Opaque snapshot payload (from save-load serialization). */
  snapshot: string
}

function isValidSave(data: unknown): data is CampaignSave {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return (
    d.version === CAMPAIGN_SAVE_VERSION &&
    typeof d.mode === 'string' &&
    (typeof d.mission === 'string' || d.mission === null) &&
    typeof d.savedAt === 'string' &&
    typeof d.snapshot === 'string'
  )
}

/** Persist a campaign snapshot. Never throws (storage may be unavailable). */
export function saveCampaignSave(data: Omit<CampaignSave, 'version' | 'savedAt'>): void {
  try {
    const payload: CampaignSave = {
      ...data,
      version: CAMPAIGN_SAVE_VERSION,
      savedAt: new Date().toISOString(),
    }
    localStorage.setItem(CAMPAIGN_SAVE_KEY, JSON.stringify(payload))
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Load the campaign snapshot, or null if none/invalid. Never throws. */
export function loadCampaignSave(): CampaignSave | null {
  try {
    const raw = localStorage.getItem(CAMPAIGN_SAVE_KEY)
    if (!raw) return null
    const data: unknown = JSON.parse(raw)
    return isValidSave(data) ? data : null
  } catch {
    return null
  }
}

/** Remove the campaign snapshot. Never throws. */
export function clearCampaignSave(): void {
  try {
    localStorage.removeItem(CAMPAIGN_SAVE_KEY)
  } catch {
    /* ignore */
  }
}

/** Whether a valid campaign snapshot exists. Never throws. */
export function hasCampaignSave(): boolean {
  return loadCampaignSave() !== null
}
