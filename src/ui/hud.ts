import { BUILDINGS } from '../data/buildings.ts'
import { FACTIONS, FACTION_IDS } from '../data/factions.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { AIDifficulty } from '../ai/opponent.ts'
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

export interface Hud {
  render(world: World): void
}

export interface HudCallbacks {
  onMode(mode: InputMode): void
  onBuildType(type: BuildingType): void
  onTrain(type: UnitType): void
  onSelectBuilding(kind: number): void
  onNewGame(): void
  onSelectIdleWorkers(): void
  onStop(): void
  onPause(): void
  onSave(): void
  onLoad(): void
  onDifficulty(d: AIDifficulty): void
  onReplay(): void
  onReplaySpeed(speed: number): void
}



/** Which unit each production building trains. */

/**
 * DOM HUD: resource bar, command mode buttons, a contextual action panel
 * (build menu for workers, train buttons for production buildings), and a
 * victory/defeat banner. mount() builds the elements once; update() refreshes
 * values and the action panel every frame from the current selection.
 */
export class HudImpl implements Hud {
  private goldEl: HTMLElement | null = null
  private woodEl: HTMLElement | null = null
  private supplyEl: HTMLElement | null = null
  private infoEl: HTMLElement | null = null
  private actionsEl: HTMLElement | null = null
  private buildingsEl: HTMLElement | null = null
  private lastBuildingsKey = ''
  private bannerEl: HTMLElement | null = null
  private callbacks: HudCallbacks | null = null
  private lastActionsKey = ''

  mount(parent: HTMLElement, callbacks?: HudCallbacks): void {
    this.callbacks = callbacks ?? null
    parent.innerHTML = `
      <div class="hud-bar">
        <span class="hud-pill hud-gold">Gold <b id="hud-gold">0</b></span>
        <span class="hud-pill hud-wood">Wood <b id="hud-wood">0</b></span>
        <span class="hud-pill">Supply <b id="hud-supply">0/0</b></span>
        <span class="hud-pill hud-info" id="hud-info"></span><button class="hud-pill hud-menu-btn" id="hud-menu-btn">☰</button>
      </div>
      
      <div class="hud-menu" id="hud-menu" hidden>
        <div class="hud-bar">
          <button class="hud-pill hud-mode" id="hud-pause">Pause</button>
          <button class="hud-pill hud-mode" id="hud-save">Save</button>
          <button class="hud-pill hud-mode" id="hud-load">Load</button>
          <button class="hud-pill hud-mode" id="hud-replay">Replay</button>
          <button class="hud-pill hud-mode" id="hud-newgame">New Game</button>
        </div>
        <div class="hud-bar" id="hud-speed" hidden>
          <button class="hud-pill hud-mode hud-speed-on" data-speed="1">1x</button>
          <button class="hud-pill hud-mode" data-speed="2">2x</button>
          <button class="hud-pill hud-mode" data-speed="4">4x</button>
        </div>
        <div class="hud-bar" id="hud-difficulty"></div>
        <div class="hud-bar">
          <label class="hud-pill">You: <select id="hud-player-faction"></select></label>
          <label class="hud-pill">Foe: <select id="hud-enemy-faction"></select></label>
        </div>
      </div>
      <div class="hud-bar hud-buildings" id="hud-buildings"></div>
      <div class="hud-bar hud-utility" id="hud-utility"><button class="hud-pill hud-action" id="hud-idle">Idle Workers</button></div>
      <div class="hud-bar hud-actions" id="hud-actions"></div>
      <div class="hud-banner" id="hud-banner" hidden></div>
      <div class="hud-tutorial" id="hud-tutorial" hidden>
        <h2>How to Play</h2>
        <p><b>Tap</b> your unit or building to select it.</p>
        <p><b>Tap</b> again to deselect.</p>
        <p>With units selected: <b>tap ground</b> to move, <b>tap enemy</b> to attack, <b>tap trees/gold</b> to gather.</p>
        <p><b>Drag</b> to box-select. <b>Two fingers</b> to pan.</p>
        <p>Use the <b>menu</b> to build, train, save, and pick factions.</p>
        <button id="hud-tutorial-close">Got it!</button>
      </div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.infoEl = parent.querySelector('#hud-info')
    this.actionsEl = parent.querySelector('#hud-actions')
    this.buildingsEl = parent.querySelector('#hud-buildings')
    const idleBtn = parent.querySelector('#hud-idle')
    if (idleBtn) idleBtn.addEventListener('click', () => this.callbacks?.onSelectIdleWorkers())
    this.bannerEl = parent.querySelector('#hud-banner')
    // First-launch tutorial.
    const tutorialEl = parent.querySelector<HTMLElement>('#hud-tutorial')
    const tutorialClose = parent.querySelector('#hud-tutorial-close')
    if (tutorialEl && tutorialClose && !localStorage.getItem('krts-tutorial-seen')) {
      tutorialEl.hidden = false
      tutorialClose.addEventListener('click', () => {
        tutorialEl.hidden = true
        localStorage.setItem('krts-tutorial-seen', '1')
      })
    }
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
    })
    wire('#hud-save', () => this.callbacks?.onSave())
    wire('#hud-load', () => this.callbacks?.onLoad())
    const speedRow = parent.querySelector<HTMLElement>('#hud-speed')
    wire('#hud-newgame', () => this.callbacks?.onNewGame())
    wire('#hud-replay', () => {
      this.callbacks?.onReplay()
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
      for (const d of ['easy', 'normal', 'hard'] as AIDifficulty[]) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (d === 'normal' ? ' hud-mode-on' : '')
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
  }

  render(world: World): void {
    this.update(world, [])
  }

  update(world: World, selected: number[]): void {
    if (this.goldEl) this.goldEl.textContent = String(Math.floor(world.gold[TEAM_PLAYER]))
    if (this.woodEl) this.woodEl.textContent = String(Math.floor(world.wood[TEAM_PLAYER]))
    if (this.supplyEl) {
      this.supplyEl.textContent = `${world.supplyUsed[TEAM_PLAYER]}/${world.supplyCap[TEAM_PLAYER]}`
    }
    if (this.infoEl) {
      let workers = 0
      let army = 0
      for (const id of world.entities.keys()) {
        if (world.team[id] !== TEAM_PLAYER) continue
        if (world.kind[id] === KIND_WORKER) workers += 1
        else if (world.kind[id] <= 2) army += 1
      }
      this.infoEl.textContent = `Workers ${workers} · Army ${army}`
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
  /** Render the RTS command card for the current selection. */
  private updateActions(world: World, selected: number[]): void {
    const el = this.actionsEl
    if (!el) return
    // Key includes HP so the card refreshes as damage is taken.
    const hpKey = selected.length > 0 ? Math.floor(world.health[selected[0]]) : 0
    const key = `${selected.join(',')}|${Math.floor(world.gold[TEAM_PLAYER])}|${Math.floor(world.wood[TEAM_PLAYER])}|${hpKey}`
    if (key === this.lastActionsKey) return
    this.lastActionsKey = key
    renderCommandCard(el, world, selected, {
      onMode: (mode) => this.callbacks?.onMode(mode as never),
      onStop: () => this.callbacks?.onStop(),
      onBuildType: (type) => this.callbacks?.onBuildType(type as never),
      onTrain: (type) => this.callbacks?.onTrain(type as never),
    })
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
