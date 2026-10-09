import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import { UNITS } from '../data/units.ts'
import type { UnitType } from '../data/units.ts'
import type { InputMode } from '../input/input-controller'
import type { World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_HALL,
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
      <div class="hud-bar hud-actions" id="hud-actions"></div>
      <div class="hud-banner" id="hud-banner" hidden></div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.infoEl = parent.querySelector('#hud-info')
    this.actionsEl = parent.querySelector('#hud-actions')
    this.bannerEl = parent.querySelector('#hud-banner')
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

    if (selected.length !== 1) return
    const id = selected[0]
    if (world.team[id] !== TEAM_PLAYER) return
    const kind = world.kind[id]

    if (kind === KIND_WORKER) {
      for (const type of PLAYER_BUILDABLE) {
        const def = BUILDINGS[type]
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-action'
        btn.textContent = `${label(type)} (${def.cost.gold}g ${def.cost.wood}w)`
        btn.disabled = !canAfford(world, TEAM_PLAYER, type)
        btn.addEventListener('click', () => this.callbacks?.onBuildType(type))
        el.appendChild(btn)
      }
    } else if (kind in TRAIN_BY_BUILDING) {
      const unit: UnitType = TRAIN_BY_BUILDING[kind]
      const def = UNITS[unit]
      const btn = document.createElement('button')
      btn.className = 'hud-pill hud-action'
      btn.textContent = `Train ${label(unit)} (${def.cost.gold}g ${def.cost.wood}w)`
      btn.disabled =
        world.gold[TEAM_PLAYER] < def.cost.gold || world.wood[TEAM_PLAYER] < def.cost.wood
      btn.addEventListener('click', () => this.callbacks?.onTrain(unit))
      el.appendChild(btn)
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
