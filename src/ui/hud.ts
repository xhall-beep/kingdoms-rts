import { BUILDINGS } from '../data/buildings.ts'
import { FACTIONS, FACTION_IDS } from '../data/factions.ts'
import { PvPLobby } from './pvp-lobby.ts'
import type { PvPClient } from '../net/client.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { AIDifficulty, AIPersonality } from '../ai/opponent.ts'
import type { AiPracticeTier } from '../net/pvp-ai.ts'
import type { InputMode } from '../input/input-controller'
import type { World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_HALL,
  KIND_WORKER,
  TEAM_PLAYER,
} from '../core/World'
import { BUILDING_TYPE_BY_KIND } from '../world/construction.ts'
import { renderCommandCard } from './command-card.ts'
import { BUILD_STAMP_LABEL } from '../build-stamp.ts'

export interface Hud {
  render(world: World): void
  setPvpActive(active: boolean): void
  /** Match-phase status line (reconnect grace, resync); null hides it. */
  setPvpStatus(msg: string | null): void
}

export interface HudCallbacks {
  onMode(mode: InputMode): void
  onBuildType(type: BuildingType): void
  onTrain(type: UnitType): void
  onResearch(type: string): void
  onSelectBuilding(kind: number): void
  onNewGame(): void
  onSelectIdleWorkers(): void
  /** Jump the camera back to the player's base (phone "lost in the dark" recovery). */
  onLocateBase(): void
  onStop(): void
  onHold(): void
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
 * dashboard. The dashboard idles at ≤56px (Idle Workers / Base / building
 * quick-select); when a selection exists it expands IN PLACE into the
 * unit/building command dashboard (rendered by command-card.ts) — there
 * is no floating selection card anywhere else. mount() builds the
 * elements once; update() refreshes values and the dashboard every frame
 * from the current selection.
 */
export class HudImpl implements Hud {
  private goldEl: HTMLElement | null = null
  private woodEl: HTMLElement | null = null
  private supplyEl: HTMLElement | null = null
  private infoEl: HTMLElement | null = null
  private armyEl: HTMLElement | null = null
  private dashEl: HTMLElement | null = null
  private actionsEl: HTMLElement | null = null
  private buildingsEl: HTMLElement | null = null
  private lastBuildingsKey = ''
  private bannerEl: HTMLElement | null = null
  private tutorialEl: HTMLElement | null = null
  private callbacks: HudCallbacks | null = null
  private lastActionsKey = ''
  private lastSelectionKey = ''
  private buildOpen = false
  private pvpLobby: PvPLobby | null = null

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
        <div class="hud-dash-idle" id="hud-dash-idle">
          <button class="hud-pill hud-action" id="hud-idle">Idle Workers</button>
          <button class="hud-pill hud-action" id="hud-locate" title="Jump camera back to your base">⌂ Base</button>
          <span class="hud-dash-army" id="hud-info-army"></span>
          <div class="hud-buildings" id="hud-buildings"></div>
        </div>
        <div class="hud-actions" id="hud-actions"></div>
      </div>
      <div class="hud-banner" id="hud-banner" hidden></div>
      <div class="hud-pvp-status" id="hud-pvp-status" hidden></div>
      <div class="hud-tutorial-backdrop" id="hud-tutorial-backdrop" hidden></div>
      <div class="hud-tutorial" id="hud-tutorial" hidden>
        <button class="hud-tutorial-x" id="hud-tutorial-x" aria-label="Close help">✕</button>
        <h2>How to Play</h2>
        <p><b>Tap</b> your unit or building to select it.</p>
        <p><b>Tap</b> again to deselect.</p>
        <p>With units selected: <b>tap ground</b> to move, <b>tap enemy</b> to attack, <b>tap trees/gold</b> to gather.</p>
        <p><b>Drag</b> to pan. <b>Hold, then drag</b> — or drag starting on a unit — to box-select.</p>
        <p><b>Double-tap</b> or <b>long-press</b> a unit to select all of its type on screen.</p>
        <p><b>Two-finger drag</b> to pan. <b>Pinch</b> to zoom.</p>
        <p>Use the <b>menu</b> to build, train, save, and pick factions.</p>
        <button id="hud-tutorial-close">Got it!</button>
      </div>
      <div class="hud-build-stamp" id="hud-build-stamp"></div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.infoEl = parent.querySelector('#hud-info')
    this.armyEl = parent.querySelector('#hud-info-army')
    this.dashEl = parent.querySelector('#hud-dash')
    this.actionsEl = parent.querySelector('#hud-actions')
    this.buildingsEl = parent.querySelector('#hud-buildings')
    const idleBtn = parent.querySelector('#hud-idle')
    if (idleBtn) idleBtn.addEventListener('click', () => this.callbacks?.onSelectIdleWorkers())
    const locateBtn = parent.querySelector('#hud-locate')
    if (locateBtn) locateBtn.addEventListener('click', () => this.callbacks?.onLocateBase())
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
    const bannerEl = parent.querySelector<HTMLElement>('#hud-banner')
    this.pvpLobby.mount(parent, {
      onMatchStart: (slot: 0 | 1, opponentName: string) => {
        if (bannerEl) {
          bannerEl.textContent = `Matched vs ${opponentName}! You are Player ${slot + 1}`
          bannerEl.hidden = false
          setTimeout(() => { bannerEl.hidden = true }, 5000)
        }
        this.callbacks?.onPvPMatchStart?.(slot, opponentName, this.pvpLobby?.getClient() ?? null, this.pvpLobby?.opponentId, this.pvpLobby?.matchCredentials.matchId, this.pvpLobby?.matchCredentials.secret, this.pvpLobby?.ratingAtMatchStart)
      },
      onError: (msg: string) => {
        if (bannerEl) {
          bannerEl.textContent = msg
          bannerEl.hidden = false
          setTimeout(() => { bannerEl.hidden = true }, 3000)
        }
      },
      onPracticeStart: (tier: AiPracticeTier) => {
        if (bannerEl) {
          bannerEl.textContent = `Practice vs AI starting...`
          bannerEl.hidden = false
          setTimeout(() => { bannerEl.hidden = true }, 3000)
        }
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
      const btn = parent.querySelector('#hud-pause')
      if (btn) btn.textContent = btn.textContent === 'Pause' ? 'Resume' : 'Pause'
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

  /** The Three Bells: announce each bell once via the HUD banner when it rings. */
  private announcedBells = [false, false, false]
  private announceBells(world: World): void {
    const names = ['🔔 First Bell — the Raid Bell', '🔔 Second Bell — the Turn', '🔔 Third Bell — the War Bell']
    for (let i = 0; i < 3; i += 1) {
      if (world.bellsRung[i] === 1 && !this.announcedBells[i]) {
        this.announcedBells[i] = true
        if (this.bannerEl) {
          this.bannerEl.textContent = names[i]
          this.bannerEl.hidden = false
          setTimeout(() => {
            if (this.bannerEl) this.bannerEl.hidden = true
          }, 4000)
        }
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

  /** Match-phase status line; separate from the banner so the per-frame
   *  updateBanner() (victory/defeat) never clobbers it. */
  setPvpStatus(msg: string | null): void {    const el = document.querySelector<HTMLElement>('#hud-pvp-status')
    if (!el) return
    if (msg === null) {
      el.hidden = true
      return
    }
    el.textContent = msg
    el.hidden = false
  }

  update(world: World, selected: number[]): void {
    if (this.goldEl) this.goldEl.textContent = String(Math.floor(world.gold[TEAM_PLAYER]))
    if (this.woodEl) this.woodEl.textContent = String(Math.floor(world.wood[TEAM_PLAYER]))
    if (this.supplyEl) {
      this.supplyEl.textContent = `${world.supplyUsed[TEAM_PLAYER]}/${world.supplyCap[TEAM_PLAYER]}`
    }
    this.announceBells(world)
    // Counts are computed once and split across the two readouts: the top
    // strip carries VP + faction extras; the dashboard idle row carries
    // Workers/Army (they no longer earn a second strip row).
    let workers = 0
    let army = 0
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_PLAYER) continue
      if (world.kind[id] === KIND_WORKER) workers += 1
      else if (world.kind[id] <= 2) army += 1
    }
    if (this.infoEl) {
      // Victory Points.
      let text = `VP ${Math.ceil(world.victoryPoints[TEAM_PLAYER])}`
      // Undead economy: show harvested Soul-Ash feeding the supply cap.
      if (world.factionOfTeam[TEAM_PLAYER] === 'undead') {
        text += ` · ☠ ${world.soulAsh[TEAM_PLAYER]}`
      }
      // War Horn charge.
      const charge = Math.floor(world.warCharge[TEAM_PLAYER])
      if (charge > 0 || (world.rallyKind[TEAM_PLAYER] !== 0 && world.rallyUntil[TEAM_PLAYER] > world.matchTime)) {
        text += ` · 📯 ${charge}`
      }
      this.infoEl.textContent = text
    }
    if (this.armyEl) {
      this.armyEl.textContent = `Workers ${workers} · Army ${army}`
    }
    this.updateActions(world, selected)
    this.updateBuildings(world)
    this.updateBanner(world)
  }

  /** Rebuild the persistent building quick-select bar (Stormgate/AoE4 pattern). */
  private updateBuildings(world: World): void {
    const el = this.buildingsEl
    if (!el) return
    // Count owned buildings by kind.
    const counts = new Map<number, number>()
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_PLAYER) continue
      const k = world.kind[id]
      if (k === KIND_HALL || k === KIND_BARRACKS || k === KIND_ARCHERY || k === KIND_FARM) {
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
    const order = [KIND_HALL, KIND_BARRACKS, KIND_ARCHERY, KIND_FARM]
    const key = order.map((k) => `${k}:${counts.get(k) ?? 0}`).join(',')
    if (key === this.lastBuildingsKey) return
    this.lastBuildingsKey = key
    el.innerHTML = ''
    for (const k of order) {
      const count = counts.get(k) ?? 0
      if (count === 0) continue
      const btype = BUILDING_TYPE_BY_KIND[k]
      const btn = document.createElement('button')
      btn.className = 'hud-pill hud-building'
      btn.textContent = count > 1 ? `${BUILDINGS[btype].name} ×${count}` : BUILDINGS[btype].name
      btn.addEventListener('click', () => this.callbacks?.onSelectBuilding(k))
      el.appendChild(btn)
    }
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
    const key = `${selKey}|${Math.floor(world.gold[TEAM_PLAYER])}|${Math.floor(world.wood[TEAM_PLAYER])}|${hpKey}|${this.buildOpen ? 1 : 0}`
    if (key === this.lastActionsKey) return
    this.lastActionsKey = key
    const shown = renderCommandCard(el, world, selected, {
      onMode: (mode) => this.callbacks?.onMode(mode as never),
      onStop: () => this.callbacks?.onStop(),
      onHold: () => this.callbacks?.onHold(),
      onBuildType: (type) => this.callbacks?.onBuildType(type as never),
      onTrain: (type) => this.callbacks?.onTrain(type as never),
      onResearch: (type) => this.callbacks?.onResearch(type),
      onMilitia: () => this.callbacks?.onMilitia(),
      onUpgrade: () => this.callbacks?.onUpgrade(),
      onWarHorn: (r) => this.callbacks?.onWarHorn(r),
      onToggleBuild: () => {
        this.buildOpen = !this.buildOpen
        this.lastActionsKey = ''
      },
    }, { buildOpen: this.buildOpen })
    // The dashboard expands in place: while the tray is shown, the idle
    // row is hidden by CSS (.hud-dash-expanded), so the tray REPLACES the
    // idle bar's space instead of stacking on top of it.
    if (this.dashEl) this.dashEl.classList.toggle('hud-dash-expanded', shown)
  }

  private updateBanner(world: World): void {
    const el = this.bannerEl
    if (!el) return
    if (world.winner === -1) {
      el.hidden = true
      return
    }
    el.hidden = false
    el.textContent = world.winner === 0 ? 'Victory!' : 'Defeat'
    el.className = 'hud-banner ' + (world.winner === 0 ? 'hud-win' : 'hud-lose')
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
