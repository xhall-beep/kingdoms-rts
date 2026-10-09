import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { UNITS } from '../data/units.ts'
import type { UnitType } from '../data/units.ts'
import type { AIDifficulty } from '../ai/opponent.ts'
import type { InputMode } from '../input/input-controller'
import type { World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_WORKER,
  TEAM_PLAYER,
} from '../core/World'
import { PLAYER_BUILDABLE, canAfford } from '../world/construction.ts'

export interface Hud {
  render(world: World): void
}

export interface HudCallbacks {
  onMode(mode: InputMode): void
  onBuildType(type: BuildingType): void
  onTrain(type: UnitType): void
  onPause(): void
  onSave(): void
  onLoad(): void
  onDifficulty(d: AIDifficulty): void
  onReplay(): void
  onReplaySpeed(speed: number): void
}

const MODES: { id: InputMode; label: string }[] = [
  { id: 'selection', label: 'Select' },
  { id: 'move', label: 'Move' },
  { id: 'attack', label: 'Attack' },
  { id: 'gather', label: 'Gather' },
]

/** Which unit each production building trains. */
const TRAIN_BY_BUILDING: Record<number, UnitType> = {
  [KIND_HALL]: 'worker',
  [KIND_BARRACKS]: 'melee',
  [KIND_ARCHERY]: 'ranged',
}

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
  private bannerEl: HTMLElement | null = null
  private modeButtons: HTMLElement[] = []
  private callbacks: HudCallbacks | null = null
  private lastActionsKey = ''

  mount(parent: HTMLElement, callbacks?: HudCallbacks): void {
    this.callbacks = callbacks ?? null
    parent.innerHTML = `
      <div class="hud-bar">
        <span class="hud-pill hud-gold">Gold <b id="hud-gold">0</b></span>
        <span class="hud-pill hud-wood">Wood <b id="hud-wood">0</b></span>
        <span class="hud-pill">Supply <b id="hud-supply">0/0</b></span>
        <span class="hud-pill hud-info" id="hud-info"></span>
      </div>
      <div class="hud-bar hud-modes" id="hud-modes"></div>
      <div class="hud-bar hud-session" id="hud-session"></div>
      <div class="hud-bar hud-actions" id="hud-actions"></div>
      <div class="hud-banner" id="hud-banner" hidden></div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.infoEl = parent.querySelector('#hud-info')
    this.actionsEl = parent.querySelector('#hud-actions')
    this.bannerEl = parent.querySelector('#hud-banner')
    const sessionEl = parent.querySelector('#hud-session')
    if (sessionEl) {
      const pauseBtn = document.createElement('button')
      pauseBtn.className = 'hud-pill hud-mode'
      pauseBtn.textContent = 'Pause'
      pauseBtn.addEventListener('click', () => {
        this.callbacks?.onPause()
        pauseBtn.textContent = pauseBtn.textContent === 'Pause' ? 'Resume' : 'Pause'
      })
      sessionEl.appendChild(pauseBtn)
      for (const [labelText, fn] of [
        ['Save', () => this.callbacks?.onSave()],
        ['Load', () => this.callbacks?.onLoad()],
      ] as const) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode'
        btn.textContent = labelText
        btn.addEventListener('click', fn)
        sessionEl.appendChild(btn)
      }
      const replayBtn = document.createElement('button')
      replayBtn.className = 'hud-pill hud-mode'
      replayBtn.textContent = 'Replay'
      replayBtn.addEventListener('click', () => {
        this.callbacks?.onReplay()
        const inReplay = replayBtn.textContent === 'Replay'
        replayBtn.textContent = inReplay ? 'Exit' : 'Replay'
        speedRow.hidden = !inReplay
      })
      sessionEl.appendChild(replayBtn)
      const speedRow = document.createElement('div')
      speedRow.className = 'hud-bar hud-session'
      speedRow.hidden = true
      for (const s of [1, 2, 4]) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (s === 1 ? ' hud-mode-on' : '')
        btn.textContent = `${s}x`
        btn.addEventListener('click', () => {
          for (const b of speedRow.querySelectorAll('button')) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          this.callbacks?.onReplaySpeed(s)
        })
        speedRow.appendChild(btn)
      }
      sessionEl.appendChild(speedRow)
      for (const d of ['easy', 'normal', 'hard'] as AIDifficulty[]) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (d === 'normal' ? ' hud-mode-on' : '')
        btn.textContent = d.charAt(0).toUpperCase() + d.slice(1)
        btn.addEventListener('click', () => {
          for (const b of sessionEl.querySelectorAll('.hud-diff')) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          this.callbacks?.onDifficulty(d)
        })
        btn.classList.add('hud-diff')
        sessionEl.appendChild(btn)
      }
    }
    const modesEl = parent.querySelector('#hud-modes')
    if (modesEl) {
      for (const { id, label } of MODES) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (id === 'selection' ? ' hud-mode-on' : '')
        btn.textContent = label
        btn.addEventListener('click', () => {
          for (const b of this.modeButtons) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          this.callbacks?.onMode(id)
        })
        modesEl.appendChild(btn)
        this.modeButtons.push(btn)
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
    this.updateBanner(world)
  }

  /** Rebuild the contextual action panel when the selection changes. */
  private updateActions(world: World, selected: number[]): void {
    const el = this.actionsEl
    if (!el) return
    const key = selected.join(',')
    if (key === this.lastActionsKey) return
    this.lastActionsKey = key
    el.innerHTML = ''

    if (selected.length === 0) return
    const own = selected.filter((id) => world.team[id] === TEAM_PLAYER)
    if (own.length === 0) return

    // Single production building: train button.
    if (own.length === 1) {
      const kind = world.kind[own[0]]
      if (kind in TRAIN_BY_BUILDING) {
        const unit: UnitType = TRAIN_BY_BUILDING[kind]
        const def = UNITS[unit]
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-action'
        btn.textContent = `Train ${label(unit)} (${def.cost.gold}g ${def.cost.wood}w)`
        btn.disabled =
          world.gold[TEAM_PLAYER] < def.cost.gold || world.wood[TEAM_PLAYER] < def.cost.wood
        btn.addEventListener('click', () => this.callbacks?.onTrain(unit))
        el.appendChild(btn)
        return
      }
    }

    // Units: composition summary + tailored quick actions.
    let workers = 0
    let melee = 0
    let ranged = 0
    for (const id of own) {
      const k = world.kind[id]
      if (k === KIND_WORKER) workers += 1
      else if (k === KIND_MELEE) melee += 1
      else if (k === KIND_RANGED) ranged += 1
    }
    if (workers + melee + ranged === 0) return

    // Composition pill (info only).
    const parts: string[] = []
    if (workers > 0) parts.push(`${workers} Worker${workers > 1 ? 's' : ''}`)
    if (melee > 0) parts.push(`${melee} Melee`)
    if (ranged > 0) parts.push(`${ranged} Ranged`)
    const info = document.createElement('span')
    info.className = 'hud-pill hud-info'
    info.textContent = parts.join(' · ')
    el.appendChild(info)

    // Quick actions tailored to the selection.
    const quick = (
      text: string,
      fn: () => void,
      disabled = false,
    ): void => {
      const btn = document.createElement('button')
      btn.className = 'hud-pill hud-action'
      btn.textContent = text
      btn.disabled = disabled
      btn.addEventListener('click', fn)
      el.appendChild(btn)
    }
    quick('Move', () => this.callbacks?.onMode('move'))
    quick('Attack', () => this.callbacks?.onMode('attack'))
    if (workers > 0) {
      // Build menu for workers (uses the first selected worker).
      for (const type of PLAYER_BUILDABLE) {
        const def = BUILDINGS[type]
        quick(
          `${label(type)} (${def.cost.gold}g ${def.cost.wood}w)`,
          () => this.callbacks?.onBuildType(type),
          !canAfford(world, TEAM_PLAYER, type),
        )
      }
    }
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

function label(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
