/**
 * Kingdom profile button + panel UI.
 *
 * Self-contained DOM module. All persistence/state logic lives in
 * ../profile/profile.ts. This module never touches the deterministic sim
 * (src/core, src/systems) — it only reads the profile and manipulates DOM.
 */
import {
  createDefaultProfile,
  loadProfile,
  recordMatchResult,
  sanitizeKingdomName,
  saveProfile,
  STORAGE_KEY,
  type Profile,
} from '../profile/profile.ts'
import { checkMilestones } from '../profile/milestones.ts'

let profile: Profile | null = null
let buttonEl: HTMLButtonElement | null = null
let panelEl: HTMLElement | null = null
let mountTimer: number | null = null
let stylesInjected = false

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function getProfile(): Profile {
  if (!profile) profile = loadProfile()
  return profile
}

/**
 * Ensure a profile exists. On first run (no stored profile), create one
 * with the default name — renaming happens via the profile panel's name
 * field. Never blocks: window.prompt() would hang headless/automated
 * pages, so it is deliberately not used here.
 */
export function ensureProfile(): Profile {
  if (profile) return profile
  if (readRaw() === null) {
    profile = createDefaultProfile('My Kingdom')
    saveProfile(profile)
  } else {
    profile = loadProfile()
  }
  return profile
}

/**
 * Record a finished match result. Intended to be called from the UI-layer
 * game-over handler (never from sim tick code).
 */
export function recordGameResult(mode: string, won: boolean): void {
  const p = ensureProfile()
  profile = recordMatchResult(p, mode, won)
  const { profile: withMilestones, unlocked } = checkMilestones(profile)
  profile = withMilestones
  saveProfile(profile)
  refreshButton()
  for (const label of unlocked) showUnlockToast(label)
}

/** Brief unlock notification banner. Never throws. */
function showUnlockToast(label: string): void {
  try {
    let el = document.querySelector<HTMLElement>('.pp-unlock-toast')
    if (!el) {
      el = document.createElement('div')
      el.className = 'pp-unlock-toast'
      document.body.appendChild(el)
    }
    el.textContent = `🏆 ${label}`
    el.classList.add('pp-show')
    window.setTimeout(() => el?.classList.remove('pp-show'), 3500)
  } catch {
    /* DOM unavailable — skip */
  }
}

/** Update the kingdom name from the profile panel. */
export function renameKingdom(name: string): void {
  const p = ensureProfile()
  profile = { ...p, kingdomName: sanitizeKingdomName(name) }
  saveProfile(profile)
  refreshButton()
}

/**
 * Mount the profile button into the HUD bar. Retries until the HUD exists,
 * so callers can invoke this once at boot without ordering concerns.
 */
export function initProfileUi(): void {
  ensureProfile()
  injectStyles()
  const tryMount = (): boolean => {
    if (buttonEl) return true
    const bar = document.querySelector('.hud-bar')
    if (!bar) return false
    buttonEl = document.createElement('button')
    buttonEl.type = 'button'
    buttonEl.className = 'hud-profile-btn'
    buttonEl.title = 'Kingdom profile'
    buttonEl.addEventListener('click', togglePanel)
    refreshButton()
    bar.appendChild(buttonEl)
    return true
  }
  if (!tryMount() && mountTimer === null) {
    mountTimer = window.setInterval(() => {
      if (tryMount() && mountTimer !== null) {
        window.clearInterval(mountTimer)
        mountTimer = null
      }
    }, 300)
  }
}

function refreshButton(): void {
  if (buttonEl) buttonEl.textContent = `\uD83D\uDC51 ${getProfile().kingdomName}`
}

function togglePanel(): void {
  if (panelEl) {
    closePanel()
  } else {
    openPanel()
  }
}

function closePanel(): void {
  if (panelEl) {
    panelEl.remove()
    panelEl = null
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function openPanel(): void {
  const p = getProfile()
  closePanel()
  panelEl = document.createElement('div')
  panelEl.className = 'kingdom-profile-panel'

  const modes = Object.keys(p.stats.perMode).sort()
  const modeRows =
    modes.length === 0
      ? '<div class="pp-row pp-dim">No matches recorded yet.</div>'
      : modes
          .map((m) => {
            const s = p.stats.perMode[m]
            return `<div class="pp-row"><span>${escapeHtml(m)}</span><span>${s.wins}W / ${s.losses}L</span></div>`
          })
          .join('')

  const factions =
    p.unlockedFactions.length > 0 ? p.unlockedFactions.map(escapeHtml).join(', ') : '\u2014'
  const buildings =
    p.unlockedBuildings.length > 0 ? p.unlockedBuildings.map(escapeHtml).join(', ') : '\u2014'
  const elo = p.ratings.pvpElo !== undefined ? String(p.ratings.pvpElo) : 'Unrated'
  const completed =
    p.campaignProgress.completedMissions.map(escapeHtml).join(', ') || '\u2014'
  const current = p.campaignProgress.currentMission
    ? escapeHtml(p.campaignProgress.currentMission)
    : '\u2014'

  panelEl.innerHTML = `
    <div class="pp-header">
      <span class="pp-title">\uD83D\uDC51 Kingdom Profile</span>
      <button type="button" class="pp-close" aria-label="Close">\u2715</button>
    </div>
    <label class="pp-row"><span>Kingdom name</span>
      <input class="pp-name" type="text" maxlength="24" value="${escapeHtml(p.kingdomName)}" />
    </label>
    <div class="pp-row"><span>Founded</span><span>${escapeHtml(fmtDate(p.createdAt))}</span></div>
    <div class="pp-section">Campaign</div>
    <div class="pp-row"><span>Current mission</span><span>${current}</span></div>
    <div class="pp-row"><span>Completed</span><span>${completed}</span></div>
    <div class="pp-section">Unlocked</div>
    <div class="pp-row"><span>Factions</span><span>${factions}</span></div>
    <div class="pp-row"><span>Buildings</span><span>${buildings}</span></div>
    <div class="pp-section">Record</div>
    ${modeRows}
    <div class="pp-section">Rating</div>
    <div class="pp-row"><span>PvP Elo</span><span>${escapeHtml(elo)}</span></div>
  `

  panelEl.querySelector('.pp-close')?.addEventListener('click', closePanel)
  const nameInput = panelEl.querySelector('.pp-name') as HTMLInputElement | null
  nameInput?.addEventListener('change', () => {
    if (nameInput) renameKingdom(nameInput.value)
  })
  // Keep game hotkeys / canvas input from firing while interacting with the panel.
  panelEl.addEventListener('keydown', (e) => e.stopPropagation())
  panelEl.addEventListener('pointerdown', (e) => e.stopPropagation())

  document.body.appendChild(panelEl)
}

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .hud-profile-btn {
      background: rgba(20, 16, 8, 0.85);
      border: 1px solid #c9a227;
      color: #f0d878;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 13px;
      cursor: pointer;
      margin-left: 8px;
    }
    .hud-profile-btn:hover { background: rgba(60, 48, 16, 0.9); }
    .kingdom-profile-panel {
      position: fixed;
      top: 56px;
      right: 12px;
      width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      background: rgba(12, 10, 6, 0.96);
      border: 1px solid #c9a227;
      border-radius: 10px;
      color: #e8dcc0;
      font-size: 13px;
      padding: 12px 14px;
      z-index: 1000;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    }
    .pp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .pp-title { color: #f0d878; font-weight: bold; font-size: 14px; }
    .pp-close { background: none; border: none; color: #e8dcc0; cursor: pointer; font-size: 14px; }
    .pp-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 3px 0; }
    .pp-dim { color: #9a8f78; }
    .pp-section { color: #c9a227; font-weight: bold; margin: 8px 0 2px; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
    .pp-name { background: #1c1812; border: 1px solid #6b5d3a; color: #f0d878; border-radius: 4px; padding: 3px 6px; width: 140px; }
    .pp-unlock-toast {
      position: fixed; top: 64px; left: 50%; transform: translateX(-50%) translateY(-12px);
      background: rgba(20, 16, 8, 0.92); border: 1px solid #c9a227; color: #f0d878;
      border-radius: 8px; padding: 10px 18px; font-size: 14px; font-weight: bold;
      z-index: 2000; opacity: 0; pointer-events: none;
      transition: opacity 0.3s, transform 0.3s;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    }
    .pp-unlock-toast.pp-show { opacity: 1; transform: translateX(-50%) translateY(0); }
  `
  document.head.appendChild(style)
}
