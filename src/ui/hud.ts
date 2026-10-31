import { BUILDINGS } from '../data/buildings.ts'
import { FACTIONS, FACTION_IDS } from '../data/factions.ts'
import { PvPLobby } from './pvp-lobby.ts'
import type { PvPClient } from '../net/client.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { AIDifficulty, AIPersonality } from '../ai/opponent.ts'
import type { AiPracticeTier } from '../net/pvp-ai.ts'
import type { InputMode, GestureMode } from '../input/input-controller'
import type { World } from '../core/World'
import type { AlertEvent, AlertKind } from '../core/World'
import { WORLD_TICKS_PER_SECOND } from '../core/time.ts'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_HALL,
  KIND_SMITHY,
  KIND_WORKER,
  KIND_WORKSHOP,
  NO_TRAINING,
  TEAM_PLAYER,
  TRAIN_QUEUE_WAITING,
} from '../core/World'
import { buildersOnSite } from '../systems/gather.ts'
import { WILD_HEAT_THRESHOLD } from '../systems/living-wild.ts'
import { BUILDING_TYPE_BY_KIND } from '../world/construction.ts'
import { renderCommandCard } from './command-card.ts'
import { BUILD_STAMP_LABEL } from '../build-stamp.ts'
import { isHeldWorker } from '../render/renderer.ts'

export type WildWrathBand = 'quiet' | 'amber' | 'hot'

export interface WildWrathDisplay {
  /** Player wild heat as a fraction of the retaliation threshold, 0..1. */
  fraction: number
  /** Lit segments of five, one per fifth of the threshold. */
  segments: number
  band: WildWrathBand
}

/**
 * Living Wild wrath, mapped sim → display. Spec §3.2 puts the wrath
 * meter on the HUD; until this slice the mechanic was invisible — heat
 * accumulated silently and the treant read as a random punishment.
 *
 * The meter reads the PLAYER team's heat against WILD_HEAT_THRESHOLD:
 * the operative quantity is distance-to-threshold, so it is a fill,
 * never a number. Bands: quiet below 60% (segments 1–3), amber from
 * 60% (the fourth segment — the forest is close to answering), red
 * pulse only at 85%+. STATE only: a treant spawning is an event, not
 * meter state, and is deliberately not signalled here.
 *
 * Form (feel-research 2026-10-26, Q1): a reserved fixed cell was the
 * first choice, but the strip's stats wrapper has ~18px of slack at
 * worst-case digit widths (Gold/Wood 4-digit, VP 1000) and VP is the
 * ellipsizable element — any cell ≥15px wide truncates "VP 1000"
 * late-game. So the meter ships as the prescribed fallback: a 5px
 * segmented sliver directly under the strip, always rendered (the
 * fixed-cell invariant: it exists at wrath 0 and never appears or
 * disappears; only segment fills and the band change).
 */
export function wildWrathDisplay(world: World): WildWrathDisplay {
  const fraction = Math.min(
    1,
    Math.max(0, world.wildHeat[TEAM_PLAYER] / WILD_HEAT_THRESHOLD),
  )
  const segments = fraction <= 0 ? 0 : Math.min(5, Math.ceil(fraction * 5))
  const band: WildWrathBand =
    fraction >= 0.85 ? 'hot' : fraction >= 0.6 ? 'amber' : 'quiet'
  return { fraction, segments, band }
}

/**
 * Event alert chip (feel research 2026-10-26, Q4 — the slice that
 * closes the game's biggest feel gap). The camera sees roughly a
 * third of the 180-unit world; until now NOTHING told the player
 * about off-screen events — a base could die while they watched
 * their wood line. The chip is the alert→camera binding (StarCraft's
 * Space-to-last-alert, two generations running) compressed for a
 * phone: one transient chip, tap → camera jumps to the event.
 *
 * Discipline, all of it deliberate:
 *  - OFF-SCREEN ONLY. An event whose location is on screen when the
 *    chip would show raises no chip — the player can already see it;
 *    flashes and rings cover the moment (decided at DISPLAY time via
 *    the renderer's camera probe: the camera may have moved since
 *    the event was pushed).
 *  - ONE chip at a time, priority attack > treant > complete; a
 *    higher-priority event preempts a lower one, never the reverse.
 *  - PER-CLASS COOLDOWN (10 sim-seconds from show time) so a
 *    sustained battle cannot re-chip every few seconds — the
 *    notification-noise failure is the anti-pattern (AoE3).
 *  - AUTO-EXPIRE after 5 sim-seconds, or earlier if the player pans
 *    the event on screen themselves.
 */
export const ALERT_PRIORITY: Record<AlertKind, number> = {
  attack: 3,
  treant: 2,
  complete: 1,
}

/** Chip text per class. */
export const ALERT_TEXT: Record<AlertKind, string> = {
  attack: '⚔ Under attack!',
  treant: '🌲 The wild stirs…',
  complete: '✓ Complete',
}

/** A class that just showed cannot re-chip for 10 sim-seconds. */
export const ALERT_COOLDOWN_TICKS = 10 * WORLD_TICKS_PER_SECOND
/** Chip lifetime before it auto-expires. */
export const ALERT_EXPIRE_TICKS = 5 * WORLD_TICKS_PER_SECOND

/** The chip currently on display. */
export interface AlertChipState {
  kind: AlertKind
  x: number
  z: number
  shownTick: number
}

/**
 * Pick the alert to display from freshly drained events: the
 * highest-priority candidate for `team` whose class is off cooldown
 * and whose location is off screen. A candidate preempts the showing
 * `current` chip only with STRICTLY higher priority. Returns null
 * when nothing should show (or preempt).
 */
export function pickAlert(
  events: readonly AlertEvent[],
  team: 0 | 1,
  current: AlertChipState | null,
  lastShownTick: Readonly<Record<AlertKind, number>>,
  tick: number,
  isOnScreen: (x: number, z: number) => boolean,
): AlertEvent | null {
  let best: AlertEvent | null = null
  for (const ev of events) {
    if (ev.team !== team) continue
    if (tick - lastShownTick[ev.kind] < ALERT_COOLDOWN_TICKS) continue
    if (isOnScreen(ev.x, ev.z)) continue
    if (best === null || ALERT_PRIORITY[ev.kind] > ALERT_PRIORITY[best.kind]) best = ev
  }
  if (best === null) return null
  if (current !== null && ALERT_PRIORITY[best.kind] <= ALERT_PRIORITY[current.kind]) return null
  return best
}

/**
 * The match-start line for local play (see HudImpl.announceOpening).
 * Exported so tests pin the exact shipped copy.
 */
export const OPENING_BANNER_TEXT =
  'Build, train, and destroy the enemy — or hold the shrine to drain their VP to 0.'

export interface Hud {
  render(world: World): void
  setPvpActive(active: boolean): void
  /** Match-phase status line (reconnect grace, resync); null hides it. */
  setPvpStatus(msg: string | null): void
  /** Armed order mode (Cancel button visibility); synced via mode listener. */
  setInputMode(mode: InputMode): void
  /** Toolbar drag-intent toggle state (Move / Select). */
  setGestureMode(mode: GestureMode): void
}

export interface HudCallbacks {
  onMode(mode: InputMode): void
  onBuildType(type: BuildingType): void
  onTrain(type: UnitType): void
  /** Tap-to-cancel production: index -1 = the active item, >= 0 = a queue index. */
  onCancelTrain(index: number): void
  onResearch(type: string): void
  onSelectBuilding(kind: number): void
  onNewGame(): void
  onSelectIdleWorkers(): void
  /** Alert chip tapped: jump the camera to the event location. */
  onAlertJump?(x: number, z: number): void
  /** Jump the camera back to the player's base (phone "lost in the dark" recovery). */
  onLocateBase(): void
  onStop(): void
  onHold(): void
  /** Toolbar drag-intent toggle: Move (drag pans) / Select (drag boxes). */
  onGestureMode(mode: GestureMode): void
  /** ✕ in the toolbar: clear the selection and disarm any armed mode. */
  onDeselect(): void
  /** Cancel in the toolbar: disarm the armed order mode, keep selection. */
  onCancelMode(): void
  onMilitia(): void
  onUpgrade(): void
  onWarHorn(rally: 1 | 2 | 3): void
  onPause(): void
  onSave(): void
  onLoad(): void
  onDifficulty(d: AIDifficulty): void
  onPersonality(p: AIPersonality): void
  onReplay(): void
  onReplaySpeed(speed: number): void
  onPvPMatchStart?: (slot: 0 | 1, opponentName: string, client: PvPClient | null, opponentId?: string, matchId?: string, matchSecret?: string, ratingAtStart?: number) => void
  onPracticeVsAi?: (tier: AiPracticeTier) => void
  onSurrender?: () => void
}



/** Which unit each production building trains. */

/**
 * DOM HUD (decluttered layout): ONE translucent top strip (resources + VP
 * read-only, ❓ Help, ☰ menu; the ⏸ pause button mounts itself into the
 * strip), a dropdown menu for session controls, and an ALWAYS-ON bottom
 * toolbar (Playtest fixes v1: the thin idle strip replaced by a robust
 * game-styled bar — drag-intent toggle Move/Select, Idle Workers,
 * Base, ✕ deselect, Cancel — plus a slim info row with Workers/Army and
 * the building quick-select). When a selection exists, the unit/building
 * command dashboard (rendered by command-card.ts) appears ABOVE the
 * toolbar — there is no floating selection card anywhere else. mount()
 * builds the elements once; update() refreshes values and the dashboard
 * every frame from the current selection.
 */
export class HudImpl implements Hud {
  private goldEl: HTMLElement | null = null
  private woodEl: HTMLElement | null = null
  private supplyEl: HTMLElement | null = null
  private wildEl: HTMLElement | null = null
  private wildSegs: HTMLElement[] = []
  /** Last rendered wrath state ("segments:band") — DOM writes only on change. */
  private lastWildKey = ''
  private alertEl: HTMLElement | null = null
  /** The alert chip on display, if any (kind + jump target + show tick). */
  private alertChip: AlertChipState | null = null
  /** Last rendered chip kind ('' = hidden) — DOM writes only on change. */
  private lastAlertKey = ''
  /** Per-class tick the chip last showed (display cooldown source). */
  private readonly alertLastShownTick: Record<AlertKind, number> = {
    attack: -1000000,
    treant: -1000000,
    complete: -1000000,
  }
  /** Camera probe injected by composition (renderer owns camera truth). */
  private alertOnScreen: ((x: number, z: number) => boolean) | null = null
  private infoEl: HTMLElement | null = null
  private armyEl: HTMLElement | null = null
  private dashEl: HTMLElement | null = null
  private actionsEl: HTMLElement | null = null
  private buildingsEl: HTMLElement | null = null
  private lastBuildingsKey = ''
  /** Last strip strings written — the strip joins the wrath sliver's rule: DOM writes only on change. */
  private lastStripText: Record<'gold' | 'wood' | 'supply' | 'info' | 'army', string> = {
    gold: '',
    wood: '',
    supply: '',
    info: '',
    army: '',
  }
  /** Sim tick + world the cached unit counts were computed from (see update()). */
  private lastCountsWorld: World | null = null
  private lastCountsTick = -1
  private cachedWorkers = 0
  private cachedArmy = 0
  private cachedStatues = 0
  /** Sim tick + world the last building-bar scan ran on (see updateBuildings()). */
  private lastBuildingsWorld: World | null = null
  private lastBuildingsTick = -1
  private bannerEl: HTMLElement | null = null
  private tutorialEl: HTMLElement | null = null
  private callbacks: HudCallbacks | null = null
  private lastActionsKey = ''
  private lastSelectionKey = ''
  private buildOpen = false
  private pvpLobby: PvPLobby | null = null
  /** Armed order mode, synced from the input controller (Cancel visibility). */
  private inputMode: InputMode = 'selection'
  private modeMoveBtn: HTMLElement | null = null
  private modeSelectBtn: HTMLElement | null = null
  private deselectBtn: HTMLElement | null = null
  private cancelBtn: HTMLElement | null = null
  private idleBtn: HTMLElement | null = null
  /** Selection presence, tracked for the ✕ cell's armed/inactive state. */
  private hasSelection = false

  mount(parent: HTMLElement, callbacks?: HudCallbacks): void {
    this.callbacks = callbacks ?? null
    parent.innerHTML = `
      <div class="hud-bar hud-strip" id="hud-strip">
        <div class="hud-strip-stats">
          <span class="hud-stat hud-gold">Gold <b id="hud-gold">0</b></span>
          <span class="hud-stat hud-wood">Wood <b id="hud-wood">0</b></span>
          <span class="hud-stat">Sup <b id="hud-supply">0/0</b></span>
          <span class="hud-stat hud-info" id="hud-info"></span>
        </div>
        <button class="hud-strip-btn" id="hud-help" title="Show the How to Play help">❓</button>
        <button class="hud-strip-btn" id="hud-menu-btn" title="Menu">☰</button>
      </div>
      <div class="hud-wild hud-wild-quiet" id="hud-wild" role="img" aria-label="Living Wild wrath — the forest answers when the bar fills" title="Living Wild wrath — the forest answers when the bar fills"><span class="hud-wild-seg"></span><span class="hud-wild-seg"></span><span class="hud-wild-seg"></span><span class="hud-wild-seg"></span><span class="hud-wild-seg"></span></div>
      <button class="hud-alert" id="hud-alert" hidden></button>

      <div class="hud-menu" id="hud-menu" hidden>
        <div class="hud-bar">
          <button class="hud-pill hud-mode" id="hud-pause">Pause</button>
          <button class="hud-pill hud-mode" id="hud-save">Save</button>
          <button class="hud-pill hud-mode" id="hud-load">Load</button>
          <button class="hud-pill hud-mode" id="hud-replay">Replay</button>
          <button class="hud-pill hud-mode" id="hud-newgame">New Game</button>
          <button class="hud-pill hud-mode" id="hud-help-menu">❓ How to Play</button>
        </div>
        <div class="hud-bar">
          <button class="hud-pill hud-mode" id="hud-pvp">⚔️ PvP</button>
          <button class="hud-pill hud-mode" id="hud-convergence" style="border: 1px solid #c084fc; color: #f5c542;">⚔️ 4 Factions Episode</button>
          <button class="hud-pill hud-mode" id="hud-td">🗼 Tower Defense</button>
          <button class="hud-pill hud-mode" id="hud-surrender" hidden>🏳️ Surrender</button>
        </div>
        <div class="hud-bar" id="hud-speed" hidden>
          <button class="hud-pill hud-mode hud-speed-on" data-speed="1">1x</button>
          <button class="hud-pill hud-mode" data-speed="2">2x</button>
          <button class="hud-pill hud-mode" data-speed="4">4x</button>
        </div>
        <div class="hud-bar" id="hud-difficulty"></div>
        <div class="hud-bar" id="hud-personality"></div>
        <div class="hud-bar">
          <label class="hud-pill">You: <select id="hud-player-faction"></select></label>
          <label class="hud-pill">Foe: <select id="hud-enemy-faction"></select></label>
        </div>
      </div>
      <div class="hud-dash" id="hud-dash">
        <div class="hud-actions" id="hud-actions"></div>
        <div class="hud-toolbar" id="hud-toolbar">
          <div class="tb-row-main">
            <div class="tb-mode" role="group" aria-label="Drag mode">
              <button class="tb-btn tb-mode-btn tb-mode-on" id="hud-mode-move" title="Drag pans the camera">✋ Move</button>
              <button class="tb-btn tb-mode-btn" id="hud-mode-select" title="Any drag draws a selection box">▦ Select</button>
            </div>
            <button class="tb-btn" id="hud-idle" aria-label="Idle Workers"><span class="tb-lines"><span>👷 Idle</span><span>Workers</span></span></button>
            <button class="tb-btn" id="hud-locate" title="Jump camera back to your base">⌂ Base</button>
            <button class="tb-btn tb-danger tb-inactive" id="hud-deselect" aria-disabled="true" title="Clear the selection">✕</button>
            <button class="tb-btn tb-cancel tb-inactive" id="hud-cancel-mode" aria-disabled="true" title="Back out of the current order without issuing it">Cancel</button>
          </div>
          <div class="tb-row-info">
            <span class="hud-dash-army" id="hud-info-army"></span>
            <div class="hud-buildings" id="hud-buildings"></div>
          </div>
        </div>
      </div>
      <div class="hud-banner" id="hud-banner" hidden></div>
      <div class="hud-pvp-status" id="hud-pvp-status" hidden></div>
      <div class="hud-tutorial-backdrop" id="hud-tutorial-backdrop" hidden></div>
      <div class="hud-tutorial" id="hud-tutorial" hidden>
        <button class="hud-tutorial-x" id="hud-tutorial-x" aria-label="Close help">✕</button>
        <h2>How to Play</h2>
        <p><b>Tap</b> your unit or building to select it.</p>
        <p><b>Tap</b> again to deselect, or tap <b>✕</b> in the toolbar to clear any selection.</p>
        <p>With units selected: <b>tap ground</b> to move, <b>tap enemy</b> to attack, <b>tap trees/gold</b> to gather.</p>
        <p><b>Drag</b> pans in <b>✋ Move</b> mode. Switch to <b>▦ Select</b> mode (toolbar, bottom) and any drag draws a selection box. <b>Pinch</b> zooms in both modes.</p>
        <p><b>Double-tap</b> or <b>long-press</b> a unit to select all of its type on screen.</p>
        <p><b>Cancel</b> backs out of placing a building or an armed Move/Attack/Gather order without issuing it. <b>Stop</b> halts a unit — it delivers what it carries, then waits for you.</p>
        <p><b>Build:</b> select a <b>Worker</b>, then tap <b>Build ▸</b>. <b>Train</b> and <b>research</b>: select the building that offers them. Idle workers gather on their own.</p>
        <p>The <b>☰ menu</b> holds Pause, Save, Load, Replay, New Game, the other game modes, AI settings, and faction picks.</p>
        <button id="hud-tutorial-close">Got it!</button>
      </div>
      <div class="hud-build-stamp" id="hud-build-stamp"></div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.wildEl = parent.querySelector('#hud-wild')
    this.wildSegs = this.wildEl
      ? [...this.wildEl.querySelectorAll('.hud-wild-seg')] as HTMLElement[]
      : []
    // Alert chip: tapping it jumps the camera to the event and
    // dismisses it. The chip is hidden by default; updateAlerts owns
    // its visibility from sim state.
    const alertBtn = parent.querySelector('#hud-alert')
    this.alertEl = alertBtn as HTMLElement | null
    if (alertBtn) alertBtn.addEventListener('click', () => {
      const chip = this.alertChip
      if (!chip) return
      this.alertChip = null
      this.callbacks?.onAlertJump?.(chip.x, chip.z)
    })
    this.infoEl = parent.querySelector('#hud-info')
    this.armyEl = parent.querySelector('#hud-info-army')
    this.dashEl = parent.querySelector('#hud-dash')
    this.actionsEl = parent.querySelector('#hud-actions')
    this.buildingsEl = parent.querySelector('#hud-buildings')
    const idleBtn = parent.querySelector('#hud-idle')
    this.idleBtn = idleBtn as HTMLElement | null
    if (idleBtn) idleBtn.addEventListener('click', () => this.callbacks?.onSelectIdleWorkers())
    const locateBtn = parent.querySelector('#hud-locate')
    if (locateBtn) locateBtn.addEventListener('click', () => this.callbacks?.onLocateBase())
    // Toolbar: drag-intent toggle, ✕ deselect, Cancel. The toggle is the
    // explicit answer to "will this drag pan or box?" — its active state
    // is visible at all times, in both the idle and selection states.
    this.modeMoveBtn = parent.querySelector('#hud-mode-move')
    this.modeSelectBtn = parent.querySelector('#hud-mode-select')
    this.deselectBtn = parent.querySelector('#hud-deselect')
    this.cancelBtn = parent.querySelector('#hud-cancel-mode')
    this.modeMoveBtn?.addEventListener('click', () => this.callbacks?.onGestureMode('move'))
    this.modeSelectBtn?.addEventListener('click', () => this.callbacks?.onGestureMode('select'))
    this.deselectBtn?.addEventListener('click', () => {
      // Fixed-grid cell: the button is always rendered; when nothing is
      // selected it is inactive and swallows the tap instead of firing.
      if (!this.hasSelection) return
      this.buildOpen = false
      this.lastActionsKey = ''
      this.callbacks?.onDeselect()
    })
    this.cancelBtn?.addEventListener('click', () => {
      if (this.inputMode === 'selection') return // inactive cell: swallow
      this.callbacks?.onCancelMode()
    })
    this.bannerEl = parent.querySelector('#hud-banner')
    // How to Play overlay: ON DEMAND ONLY — it never appears on load, flag
    // or no flag; the ❓ Help button is the only way in. Auto-showing it on
    // every launch turned it into a wall in front of the game, and for two
    // shipped builds the wall was undismissable: the deploy pipeline
    // silently dropped the freshly built stylesheet, so the page ran a
    // stale .hud-tutorial rule with no pointer-events opt-in and the card
    // (inside pointer-events:none #hud-root) could not be tapped at all.
    // The pipeline now inlines the built CSS — see kingdoms-deploy-all.py.
    // Dismissal paths, all wired here: the ✕, the "Got it!" button, and a
    // tap on the dimmed backdrop anywhere outside the card.
    this.tutorialEl = parent.querySelector<HTMLElement>('#hud-tutorial')
    const backdropEl = parent.querySelector<HTMLElement>('#hud-tutorial-backdrop')
    const dismissTutorial = (): void => {
      if (this.tutorialEl) this.tutorialEl.hidden = true
      if (backdropEl) backdropEl.hidden = true
    }
    const showTutorial = (): void => {
      if (backdropEl) backdropEl.hidden = false
      if (this.tutorialEl) this.tutorialEl.hidden = false
    }
    parent.querySelector('#hud-tutorial-close')?.addEventListener('click', dismissTutorial)
    parent.querySelector('#hud-tutorial-x')?.addEventListener('click', dismissTutorial)
    backdropEl?.addEventListener('click', dismissTutorial)
    const helpBtn = parent.querySelector('#hud-help')
    if (helpBtn) helpBtn.addEventListener('click', showTutorial)
    // Build stamp: tiny corner tag so screenshots identify their build.
    const stampEl = parent.querySelector('#hud-build-stamp')
    if (stampEl) stampEl.textContent = BUILD_STAMP_LABEL
    // Faction pickers.
    const playerSel = parent.querySelector<HTMLSelectElement>('#hud-player-faction')
    const enemySel = parent.querySelector<HTMLSelectElement>('#hud-enemy-faction')
    if (playerSel && enemySel) {
      const savedPlayer = localStorage.getItem('krts-player-faction') || 'human'
      const savedEnemy = localStorage.getItem('krts-enemy-faction') || 'orc'
      for (const fid of FACTION_IDS) {
        const opt1 = document.createElement('option')
        opt1.value = fid
        opt1.textContent = FACTIONS[fid].name
        if (fid === savedPlayer) opt1.selected = true
        playerSel.appendChild(opt1)
        const opt2 = document.createElement('option')
        opt2.value = fid
        opt2.textContent = FACTIONS[fid].name
        if (fid === savedEnemy) opt2.selected = true
        enemySel.appendChild(opt2)
      }
      playerSel.addEventListener('change', () => {
        localStorage.setItem('krts-player-faction', playerSel.value)
      })
      enemySel.addEventListener('change', () => {
        localStorage.setItem('krts-enemy-faction', enemySel.value)
      })
    }
    // Menu toggle.
    const menuBtn = parent.querySelector('#hud-menu-btn')
    const menuEl = parent.querySelector<HTMLElement>('#hud-menu')
    // Session actions close the dropdown after firing so the menu never
    // lingers over the game as a stuck layer. Pickers (difficulty,
    // personality, factions) intentionally leave it open.
    const closeMenu = (): void => {
      if (menuEl) menuEl.hidden = true
    }
    // PvP lobby
    this.pvpLobby = new PvPLobby()
    this.pvpLobby.mount(parent, {
      onMatchStart: (slot: 0 | 1, opponentName: string) => {
        this.showBanner(`Matched vs ${opponentName}! You are Player ${slot + 1}`, 5000)
        this.callbacks?.onPvPMatchStart?.(slot, opponentName, this.pvpLobby?.getClient() ?? null, this.pvpLobby?.opponentId, this.pvpLobby?.matchCredentials.matchId, this.pvpLobby?.matchCredentials.secret, this.pvpLobby?.ratingAtMatchStart)
      },
      onError: (msg: string) => {
        this.showBanner(msg, 3000)
      },
      onPracticeStart: (tier: AiPracticeTier) => {
        this.showBanner(`Practice vs AI starting...`, 3000)
        this.callbacks?.onPracticeVsAi?.(tier)
      },
    })
    const pvpBtn = parent.querySelector('#hud-pvp')
    pvpBtn?.addEventListener('click', () => {
      closeMenu()
      if (this.pvpLobby?.isVisible) this.pvpLobby.hide()
      else this.pvpLobby?.show()
    })
    const convBtn = parent.querySelector('#hud-convergence')
    convBtn?.addEventListener('click', () => {
      if (confirm('Launch The Shattered Convergence (4 Factions Episode)? Current game will restart.')) {
        localStorage.setItem('krts-game-mode', 'convergence')
        location.reload()
      }
    })
    const tdBtn = parent.querySelector('#hud-td')
    tdBtn?.addEventListener('click', () => {
      if (confirm('Start Tower Defense mode? Current game will restart.')) {
        localStorage.setItem('krts-game-mode', 'tower-defense')
        location.reload()
      }
    })
    if (menuBtn && menuEl) {
      menuBtn.addEventListener('click', () => {
        menuEl.hidden = !menuEl.hidden
      })
    }
    // Session buttons (in the menu).
    const wire = (id: string, fn: () => void): void => {
      const btn = parent.querySelector(id)
      if (btn) btn.addEventListener('click', fn)
    }
    wire('#hud-pause', () => {
      this.callbacks?.onPause()
      // The label is NOT flipped here: pause-overlay syncs it from the
      // engine's paused state after every transition, whichever
      // surface toggled it (audit fix H — one source of truth).
      closeMenu()
    })
    // Help also lives in the menu (the strip's ❓ button is the primary
    // hook — the smoke gate taps it by id — this entry is the discoverable
    // path for players who open the menu first).
    wire('#hud-help-menu', () => {
      closeMenu()
      showTutorial()
    })
    wire('#hud-save', () => {
      this.callbacks?.onSave()
      closeMenu()
    })
    wire('#hud-load', () => {
      this.callbacks?.onLoad()
      closeMenu()
    })
    wire('#hud-surrender', () => {
      closeMenu()
      showConfirmModal('Surrender this match? It will count as a loss.', () => {
        this.callbacks?.onSurrender?.()
      })
    })
    const speedRow = parent.querySelector<HTMLElement>('#hud-speed')
    wire('#hud-newgame', () => {
      this.callbacks?.onNewGame()
      closeMenu()
    })
    wire('#hud-replay', () => {
      this.callbacks?.onReplay()
      closeMenu()
      const btn = parent.querySelector('#hud-replay')
      const inReplay = btn && btn.textContent === 'Replay'
      if (btn) btn.textContent = inReplay ? 'Exit' : 'Replay'
      if (speedRow) speedRow.hidden = !inReplay
    })
    if (speedRow) {
      for (const btn of speedRow.querySelectorAll('button')) {
        btn.addEventListener('click', () => {
          for (const b of speedRow.querySelectorAll('button')) b.classList.remove('hud-speed-on')
          btn.classList.add('hud-speed-on')
          this.callbacks?.onReplaySpeed(Number(btn.dataset.speed))
        })
      }
    }
    const diffEl = parent.querySelector('#hud-difficulty')
    if (diffEl) {
      const savedDiff = (localStorage.getItem('krts-ai-difficulty') || 'normal') as AIDifficulty
      for (const d of ['easy', 'normal', 'hard'] as AIDifficulty[]) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (d === savedDiff ? ' hud-mode-on' : '')
        btn.textContent = d.charAt(0).toUpperCase() + d.slice(1)
        btn.addEventListener('click', () => {
          for (const b of diffEl.querySelectorAll('.hud-diff')) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          this.callbacks?.onDifficulty(d)
        })
        btn.classList.add('hud-diff')
        diffEl.appendChild(btn)
      }
    }
    // AI personality picker (aggressor / defender / expander).
    const persEl = parent.querySelector('#hud-personality')
    if (persEl) {
      const savedPers = (localStorage.getItem('krts-ai-personality') || 'expander') as AIPersonality
      for (const p of ['aggressor', 'defender', 'expander'] as AIPersonality[]) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode hud-pers' + (p === savedPers ? ' hud-mode-on' : '')
        btn.textContent = p.charAt(0).toUpperCase() + p.slice(1)
        btn.addEventListener('click', () => {
          for (const b of persEl.querySelectorAll('.hud-pers')) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          this.callbacks?.onPersonality(p)
        })
        persEl.appendChild(btn)
      }
    }
  }

  render(world: World): void {
    this.update(world, [])
  }

  private announcedBells = [false, false, false]
  /** Deadline (performance.now) of the transient banner message that
   * currently owns the banner lane, if any. updateBanner respects the
   * lease; victory/defeat outranks it. */
  private bannerLeaseUntil = 0

  /** Show a transient message in the banner lane (bells, PvP match
   * events). Before the lease existed, updateBanner — which runs later
   * in the same update() — hid the banner in the very frame one of
   * these writers showed it, so transient banners never displayed. */
  private showBanner(text: string, ms: number, className = 'hud-banner'): void {
    const el = this.bannerEl
    if (!el) return
    el.textContent = text
    el.className = className
    el.hidden = false
    this.bannerLeaseUntil = performance.now() + ms
  }

  /**
   * Opening direction for a local match (basics audit F1, 2026-10-31):
   * local play used to start in total silence — no banner, no
   * objective — and the first banner a new player ever saw named the
   * unexplained First Bell at 3:00. main.ts calls this once for the
   * standard local mode; PvP and practice announce their own starts
   * through the lobby, and the special modes carry their own overlays.
   * Every claim in the line is a shipped fact: build/train are the
   * opening verbs (cards), annihilation is the victory system's
   * elimination rule, and a held shrine drains the enemy's VP to the
   * same system's VP defeat. The note class (smaller, wrapping) is
   * what lets one honest line fit a 412px screen — the 22px nowrap
   * announcement style fits ~30 characters.
   */
  announceOpening(): void {
    this.showBanner(OPENING_BANNER_TEXT, 5000, 'hud-banner hud-banner-note')
  }

  /**
   * A refused command names its reason in the banner lane (basics
   * audit F5): the error tint keeps it from reading as an
   * announcement, and the 3000ms lease matches the PvP lobby's error
   * precedent. The text comes from the caller — main.ts formats the
   * RefusalReason the sim's own guard chain computed.
   */
  announceRefusal(text: string): void {
    this.showBanner(text, 3000, 'hud-banner hud-banner-error')
  }

  /** The Three Bells: announce each bell once via the HUD banner when it rings. */
  private announceBells(world: World): void {
    // The First Bell carries its meaning with it (audit F1): the bare
    // name told a cold player nothing. bells.ts's contract is that the
    // First Bell ends the quiet opening and opens the raid phase — the
    // first probe itself waits out the AI's opening advance floor
    // (225s aggressor/defender, 240s expander; OPENING_ADVANCE_DELAY_SEC),
    // so the banner announces the probe as coming, never as launched.
    // The note class gives the longer line room to fit.
    const names = [
      "🔔 First Bell — the Raid Bell: the enemy's first probe is coming",
      '🔔 Second Bell — the Turn',
      '🔔 Third Bell — the War Bell',
    ]
    for (let i = 0; i < 3; i += 1) {
      if (world.bellsRung[i] === 1 && !this.announcedBells[i]) {
        this.announcedBells[i] = true
        this.showBanner(names[i], 4000, i === 0 ? 'hud-banner hud-banner-note' : 'hud-banner')
        try {
          if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(80)
        } catch { /* noop */ }
      }
      // A fresh match resets announcements (bellsRung cleared on new world).
      if (world.bellsRung[i] === 0) this.announcedBells[i] = false
    }
  }

  /** Show or hide the PvP surrender button (visible only during a live match). */
  setPvpActive(active: boolean): void {
    const btn = document.querySelector<HTMLElement>('#hud-surrender')
    if (btn) btn.hidden = !active
    if (!active) this.setPvpStatus(null)
  }

  /** Armed order mode, synced from the input controller's mode listener. */
  setInputMode(mode: InputMode): void {
    this.inputMode = mode
    this.refreshToolbarButtons()
  }

  /** Toolbar drag-intent toggle state (Move / Select). */
  setGestureMode(mode: GestureMode): void {
    this.modeMoveBtn?.classList.toggle('tb-mode-on', mode === 'move')
    this.modeSelectBtn?.classList.toggle('tb-mode-on', mode === 'select')
  }

  /**
   * Wire the camera probe the alert chip uses for its off-screen test
   * (composition injects the renderer's isWorldPointOnScreen). Until a
   * probe is wired, every point reads as off-screen: a HUD without a
   * camera has no jump target anyway, and alerts must not be silently
   * swallowed by a missing wire.
   */
  setAlertViewportProbe(probe: ((x: number, z: number) => boolean) | null): void {
    this.alertOnScreen = probe
  }

  /**
   * Event alert chip: drain the world's visual-only alert queue and
   * show at most one chip for the player's team (pickAlert owns the
   * gating: off-screen only, per-class cooldown, priority preemption).
   * The HUD is the queue's sole drainer — the frame loop updates the
   * HUD every frame after the renderer draws. A showing chip retires
   * on expiry, or early when the player pans the event on screen
   * themselves. DOM writes only when the display key changes (the
   * wrath sliver's pattern).
   */
  private updateAlerts(world: World): void {
    const events = world.alertEvents.splice(0, world.alertEvents.length)
    const onScreen = this.alertOnScreen ?? ((): boolean => false)
    const pick = pickAlert(
      events,
      TEAM_PLAYER,
      this.alertChip,
      this.alertLastShownTick,
      world.tick,
      onScreen,
    )
    if (pick !== null) {
      this.alertChip = { kind: pick.kind, x: pick.x, z: pick.z, shownTick: world.tick }
      this.alertLastShownTick[pick.kind] = world.tick
    } else if (this.alertChip !== null) {
      if (
        world.tick - this.alertChip.shownTick >= ALERT_EXPIRE_TICKS ||
        onScreen(this.alertChip.x, this.alertChip.z)
      ) {
        this.alertChip = null
      }
    }
    if (!this.alertEl) return
    this.syncAlertLane()
    const key = this.alertChip === null ? '' : this.alertChip.kind
    if (key === this.lastAlertKey) return
    this.lastAlertKey = key
    if (this.alertChip === null) {
      this.alertEl.hidden = true
      this.alertEl.textContent = ''
      this.alertEl.className = 'hud-alert'
    } else {
      this.alertEl.hidden = false
      this.alertEl.textContent = ALERT_TEXT[this.alertChip.kind]
      this.alertEl.className = `hud-alert hud-alert-${this.alertChip.kind}`
    }
  }

  private alertLaneApplied = -1
  private pvpStatusEl: HTMLElement | null = null

  /** The chip's lane yields to whatever else owns the top centre: the
   * banner (top 52, ~50 tall) first, then the PvP status line (top
   * 104, ~38 tall). With the banner lease in place the two can truly
   * coincide (a bell ringing out mid-attack), and sharing the 56px
   * lane stacked them on the same pixels. Written only on change. */
  private syncAlertLane(): void {
    if (!this.alertEl) return
    if (!this.pvpStatusEl && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      this.pvpStatusEl = document.querySelector<HTMLElement>('#hud-pvp-status')
    }
    const bannerShown = this.bannerEl !== null && !this.bannerEl.hidden
    const statusShown = this.pvpStatusEl !== null && !this.pvpStatusEl.hidden
    const top = statusShown ? 148 : bannerShown ? 110 : 56
    if (top !== this.alertLaneApplied) {
      this.alertLaneApplied = top
      if (this.alertEl.style) this.alertEl.style.top = `${top}px`
    }
  }

  /**
   * Fixed-grid toolbar (WC3/SC2 command-card invariant): cells never
   * appear, disappear, or move — state renders INSIDE the cell. ✕ is
   * armed iff a selection exists; Cancel iff an order mode is armed.
   * Inapplicable cells render greyed/inactive in their reserved slot
   * instead of hiding (the old show/hide pattern is what let the row
   * overflow the screen in the armed+selection state).
   */
  private refreshToolbarButtons(): void {
    if (this.cancelBtn) {
      const off = this.inputMode === 'selection'
      this.cancelBtn.classList.toggle('tb-inactive', off)
      this.cancelBtn.setAttribute('aria-disabled', String(off))
    }
    if (this.deselectBtn) {
      const off = !this.hasSelection
      this.deselectBtn.classList.toggle('tb-inactive', off)
      this.deselectBtn.setAttribute('aria-disabled', String(off))
    }
  }
  setPvpStatus(msg: string | null): void {    const el = document.querySelector<HTMLElement>('#hud-pvp-status')
    if (!el) return
    if (msg === null) {
      el.hidden = true
      return
    }
    el.textContent = msg
    el.hidden = false
  }

  /** Write a strip readout only when its string actually changed. The
   *  strip previously paid 5 string allocations + DOM writes per frame
   *  at 60 fps even while the sim stood still (perf pass 2026-10-27);
   *  these elements are written nowhere else, so the guard is exact. */
  private setStripText(el: HTMLElement | null, key: 'gold' | 'wood' | 'supply' | 'info' | 'army', value: string): void {
    if (!el) return
    if (this.lastStripText[key] === value) return
    this.lastStripText[key] = value
    el.textContent = value
  }

  update(world: World, selected: number[]): void {
    this.setStripText(this.goldEl, 'gold', String(Math.floor(world.gold[TEAM_PLAYER])))
    this.setStripText(this.woodEl, 'wood', String(Math.floor(world.wood[TEAM_PLAYER])))
    this.setStripText(this.supplyEl, 'supply', `${world.supplyUsed[TEAM_PLAYER]}/${world.supplyCap[TEAM_PLAYER]}`)
    // Living Wild wrath sliver: fixed cell, always rendered; only the
    // segment fills and the band class change, and only when the
    // mapped display state actually changed.
    if (this.wildEl && this.wildSegs.length === 5) {
      const wrath = wildWrathDisplay(world)
      const key = `${wrath.segments}:${wrath.band}`
      if (key !== this.lastWildKey) {
        this.lastWildKey = key
        this.wildEl.className = `hud-wild hud-wild-${wrath.band}`
        for (let i = 0; i < 5; i += 1) {
          this.wildSegs[i].classList.toggle('hud-wild-seg-on', i < wrath.segments)
        }
      }
    }
    this.updateAlerts(world)
    this.announceBells(world)
    // Counts are computed once and split across the two readouts: the top
    // strip carries VP + faction extras; the dashboard idle row carries
    // Workers/Army (they no longer earn a second strip row).
    //
    // Per-frame scan guard: update() runs every rAF frame but the counts
    // derive only from sim state, and the sim moves only inside
    // world.update() (which bumps world.tick exactly once per step) or
    // on world replacement — so a frame on an already-scanned
    // (world, tick) recomputes the identical counts. The bound on
    // staleness: a local command applied between ticks (train taps
    // apply immediately in local play) lands in these counts at most
    // one sim tick (1/60 sim-second) late, display-only — the sim and
    // its hash never read the HUD, and the selected building's own
    // command card is keyed separately and stays live every frame.
    let workers: number
    let army: number
    let statues: number
    if (this.lastCountsWorld === world && this.lastCountsTick === world.tick) {
      workers = this.cachedWorkers
      army = this.cachedArmy
      statues = this.cachedStatues
    } else {
      workers = 0
      army = 0
      statues = 0
      for (const id of world.entities.keys()) {
        if (world.team[id] !== TEAM_PLAYER) continue
        if (world.kind[id] === KIND_WORKER) {
          workers += 1
          if (isHeldWorker(world, id)) statues += 1
        } else if (world.kind[id] <= 2) army += 1
      }
      this.lastCountsWorld = world
      this.lastCountsTick = world.tick
      this.cachedWorkers = workers
      this.cachedArmy = army
      this.cachedStatues = statues
    }
    // Statues exist: pulse the Idle Workers button. It already selects
    // exactly these workers (STATE_IDLE + empty hands), so recovery is one
    // discoverable tap away — tap it, then Gather, and the squad works.
    this.idleBtn?.classList.toggle('tb-pulse', statues > 0)
    // Top strip carries VP only now: the old combined string (VP + Soul-Ash
    // + horn charge) ellipsized into uselessness ("VP 1…") on a 412px
    // phone. The extras live in the toolbar info row, where they fit.
    this.setStripText(this.infoEl, 'info', `VP ${Math.ceil(world.victoryPoints[TEAM_PLAYER])}`)
    {
      let armyText = `Workers ${workers} · Army ${army}`
      // Undead economy: show harvested Soul-Ash feeding the supply cap.
      if (world.factionOfTeam[TEAM_PLAYER] === 'undead') {
        armyText += ` · ☠ ${world.soulAsh[TEAM_PLAYER]}`
      }
      // War Horn charge.
      const charge = Math.floor(world.warCharge[TEAM_PLAYER])
      if (charge > 0 || (world.rallyKind[TEAM_PLAYER] !== 0 && world.rallyUntil[TEAM_PLAYER] > world.matchTime)) {
        armyText += ` · 📯 ${charge}`
      }
      this.setStripText(this.armyEl, 'army', armyText)
    }
    this.updateActions(world, selected)
    this.updateBuildings(world)
    this.updateBanner(world)
  }

  /** Rebuild the persistent building quick-select bar (Stormgate/AoE4 pattern). */
  private updateBuildings(world: World): void {
    const el = this.buildingsEl
    if (!el) return
    // Same tick-guard as the counts scan in update(): the pill key
    // derives only from sim state, so a frame on an unchanged tick
    // recomputes the identical key — skip the scan and the two fresh
    // Map allocations per frame (perf pass 2026-10-27). The existing
    // key comparison below still guards the DOM rebuild itself.
    if (this.lastBuildingsWorld === world && this.lastBuildingsTick === world.tick) return
    this.lastBuildingsWorld = world
    this.lastBuildingsTick = world.tick
    // Count owned buildings by kind, and how many production ITEMS
    // (active slot + waiting queue) each kind has in production — the
    // pill badge (⏳N) must be readable without selecting anything.
    const counts = new Map<number, number>()
    const training = new Map<number, number>()
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_PLAYER) continue
      const k = world.kind[id]
      if (
        k === KIND_HALL || k === KIND_BARRACKS || k === KIND_ARCHERY || k === KIND_FARM ||
        k === KIND_WORKSHOP || k === KIND_SMITHY
      ) {
        counts.set(k, (counts.get(k) ?? 0) + 1)
        const items =
          (world.trainKind[id] !== NO_TRAINING ? 1 : 0) + world.trainQueueLen[id]
        if (items > 0) {
          training.set(k, (training.get(k) ?? 0) + items)
        }
      }
    }
    const order = [KIND_HALL, KIND_BARRACKS, KIND_WORKSHOP, KIND_SMITHY, KIND_ARCHERY, KIND_FARM]
    const key = order.map((k) => `${k}:${counts.get(k) ?? 0}:${training.get(k) ?? 0}`).join(',')
    if (key === this.lastBuildingsKey) return
    this.lastBuildingsKey = key
    el.innerHTML = ''
    for (const k of order) {
      const count = counts.get(k) ?? 0
      if (count === 0) continue
      const btype = BUILDING_TYPE_BY_KIND[k]
      const btn = document.createElement('button')
      btn.className = 'hud-pill hud-building'
      const trainingNow = training.get(k) ?? 0
      const badge = trainingNow > 0 ? ` ⏳${trainingNow > 1 ? trainingNow : ''}` : ''
      btn.textContent = (count > 1 ? `${BUILDINGS[btype].name} ×${count}` : BUILDINGS[btype].name) + badge
      btn.addEventListener('click', () => this.callbacks?.onSelectBuilding(k))
      el.appendChild(btn)
    }
    // Scroll affordance: when the pills overflow the row, the CSS fade
    // on the right edge marks that more pills exist off-screen (the
    // scrollbar is hidden by design). A rebuild is the only moment the
    // content width can change, so the check rides it.
    el.classList.toggle('tb-scrollable', el.scrollWidth > el.clientWidth + 1)
  }

  /** Rebuild the contextual info + action panel when the selection changes. */
  /** Render the RTS command card into the bottom dashboard tray. */
  private updateActions(world: World, selected: number[]): void {
    const el = this.actionsEl
    if (!el) return
    // A selection change closes the worker Build sub-menu.
    const selKey = selected.join(',')
    if (selKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selKey
      this.buildOpen = false
    }
    // Key includes HP so the card refreshes as damage is taken. For a
    // group selection this is the AGGREGATE HP, so the group card's bar
    // moves when any member is hurt, not just the first.
    let hpKey = 0
    for (const sid of selected) hpKey += Math.floor(world.health[sid] ?? 0)
    // Training + construction state for a selected building, so its
    // card's progress bar/countdown, builder line and queue chips stay
    // live: the countdown is keyed at decisecond granularity (smooth
    // enough, bounded re-renders), build progress at whole points, and
    // the queue by its length + queued kinds in order.
    let stateKey = ''
    if (selected.length === 1) {
      const sid = selected[0]
      const k = world.kind[sid]
      if (
        k === KIND_HALL || k === KIND_BARRACKS || k === KIND_ARCHERY || k === KIND_FARM ||
        k === KIND_WORKSHOP || k === KIND_SMITHY
      ) {
        let queueKey = ''
        const qBase = sid * TRAIN_QUEUE_WAITING
        for (let qi = 0; qi < world.trainQueueLen[sid]; qi += 1) {
          queueKey += `${world.trainQueueKind[qBase + qi]},`
        }
        stateKey =
          `${world.trainKind[sid]}:${Math.round(world.trainLeft[sid] * 10)}:` +
          `${Math.floor(world.buildProgress[sid])}:${buildersOnSite(world, sid)}:${queueKey}`
      }
    }
    const key = `${selKey}|${Math.floor(world.gold[TEAM_PLAYER])}|${Math.floor(world.wood[TEAM_PLAYER])}|${hpKey}|${stateKey}|${this.buildOpen ? 1 : 0}`
    if (key === this.lastActionsKey) return
    this.lastActionsKey = key
    const shown = renderCommandCard(el, world, selected, {
      onMode: (mode) => this.callbacks?.onMode(mode as never),
      onStop: () => this.callbacks?.onStop(),
      onHold: () => this.callbacks?.onHold(),
      onBuildType: (type) => this.callbacks?.onBuildType(type as never),
      onTrain: (type) => this.callbacks?.onTrain(type as never),
      onCancelTrain: (index) => this.callbacks?.onCancelTrain(index),
      onResearch: (type) => this.callbacks?.onResearch(type),
      onMilitia: () => this.callbacks?.onMilitia(),
      onUpgrade: () => this.callbacks?.onUpgrade(),
      onWarHorn: (r) => this.callbacks?.onWarHorn(r),
      onToggleBuild: () => {
        this.buildOpen = !this.buildOpen
        this.lastActionsKey = ''
      },
    }, { buildOpen: this.buildOpen })
    // The dashboard expands in place: while the tray is shown, the tray
    // sits ABOVE the always-visible toolbar (never stacked under it).
    if (this.dashEl) this.dashEl.classList.toggle('hud-dash-expanded', shown)
    // ✕ / Cancel are permanent toolbar cells (fixed grid): track their
    // armed state here; refreshToolbarButtons renders it in-cell.
    this.hasSelection = selected.length > 0
    this.refreshToolbarButtons()
  }

  private updateBanner(world: World): void {
    const el = this.bannerEl
    if (!el) return
    if (world.winner !== -1) {
      this.bannerLeaseUntil = 0
      el.hidden = false
      el.textContent = world.winner === 0 ? 'Victory!' : 'Defeat'
      el.className = 'hud-banner ' + (world.winner === 0 ? 'hud-win' : 'hud-lose')
      return
    }
    // A transient announcement (bell / PvP match message) owns the lane
    // until its lease lapses; this method used to hide the banner in
    // the same frame announceBells showed it, so bell banners were
    // written but never displayed.
    if (performance.now() < this.bannerLeaseUntil) return
    el.hidden = true
  }
}

/**
 * Non-blocking confirm dialog. The native confirm() halts the JS thread,
 * which would stall our lockstep turn pump (and freeze the opponent's
 * screen) for as long as the dialog sits open. This modal lets the
 * simulation keep running underneath.
 */
export function showConfirmModal(message: string, onConfirm: () => void): void {
  document.getElementById('hud-confirm-modal')?.remove()
  const modal = document.createElement('div')
  modal.id = 'hud-confirm-modal'
  modal.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:2000;'
  modal.innerHTML = `
    <div style="background:#1a2b2b;color:#fff;padding:28px 36px;border-radius:12px;text-align:center;max-width:320px;">
      <div style="font-size:16px;margin-bottom:24px;">${message}</div>
      <div>
        <button id="hud-confirm-yes" style="padding:10px 24px;font-size:16px;margin-right:8px;cursor:pointer;background:#b45309;color:#fff;border:none;border-radius:8px;">Surrender</button>
        <button id="hud-confirm-no" style="padding:10px 24px;font-size:16px;cursor:pointer;">Cancel</button>
      </div>
    </div>`
  document.body.appendChild(modal)
  const close = () => modal.remove()
  modal.querySelector('#hud-confirm-no')!.addEventListener('click', close)
  modal.querySelector('#hud-confirm-yes')!.addEventListener('click', () => {
    close()
    onConfirm()
  })
}
