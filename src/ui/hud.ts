import type { InputMode } from '../input/input-controller'
import type { World } from '../core/World'
import { KIND_WORKER, TEAM_PLAYER } from '../core/World'

export interface Hud {
  render(world: World): void
}

const MODES: { id: InputMode; label: string }[] = [
  { id: 'selection', label: 'Select' },
  { id: 'move', label: 'Move' },
  { id: 'attack', label: 'Attack' },
  { id: 'gather', label: 'Gather' },
]

/**
 * DOM HUD: resource bar (gold / wood / supply), army status, and touch-friendly
 * command mode buttons. mount() builds the elements once; update() refreshes
 * values every frame.
 */
export class HudImpl implements Hud {
  private goldEl: HTMLElement | null = null
  private woodEl: HTMLElement | null = null
  private supplyEl: HTMLElement | null = null
  private infoEl: HTMLElement | null = null
  private modeButtons: HTMLElement[] = []

  mount(parent: HTMLElement, onMode?: (mode: InputMode) => void): void {
    parent.innerHTML = `
      <div class="hud-bar">
        <span class="hud-pill hud-gold">Gold <b id="hud-gold">0</b></span>
        <span class="hud-pill hud-wood">Wood <b id="hud-wood">0</b></span>
        <span class="hud-pill">Supply <b id="hud-supply">0/0</b></span>
        <span class="hud-pill hud-info" id="hud-info"></span>
      </div>
      <div class="hud-bar hud-modes" id="hud-modes"></div>`
    this.goldEl = parent.querySelector('#hud-gold')
    this.woodEl = parent.querySelector('#hud-wood')
    this.supplyEl = parent.querySelector('#hud-supply')
    this.infoEl = parent.querySelector('#hud-info')
    const modesEl = parent.querySelector('#hud-modes')
    if (modesEl) {
      for (const { id, label } of MODES) {
        const btn = document.createElement('button')
        btn.className = 'hud-pill hud-mode' + (id === 'selection' ? ' hud-mode-on' : '')
        btn.textContent = label
        btn.addEventListener('click', () => {
          for (const b of this.modeButtons) b.classList.remove('hud-mode-on')
          btn.classList.add('hud-mode-on')
          onMode?.(id)
        })
        modesEl.appendChild(btn)
        this.modeButtons.push(btn)
      }
    }
  }

  render(world: World): void {
    this.update(world)
  }

  update(world: World): void {
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
  }
}
