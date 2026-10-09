import type { World } from '../core/World'
import {
  HARVEST_GOLD,
  HARVEST_WOOD,
  KIND_GOLDMINE,
  KIND_RANGED,
  KIND_TREE,
  KIND_WORKER,
  TEAM_PLAYER,
} from '../core/World'
import type { Renderer } from '../render/renderer'
import { orderAttack } from '../systems/combat'
import { orderGather } from '../systems/gather'
import { orderMove } from '../systems/movement'

export type InputMode = 'selection' | 'move' | 'attack' | 'gather'

export interface InputController {
  setMode(mode: InputMode): void
  getMode(): InputMode
  handlePointer(position: readonly [number, number]): void
}

const PICK_RADIUS = 1.6 // world units

/**
 * Pointer input: left-click selects, left-drag pans, wheel zooms,
 * right-click issues smart orders (move / attack / gather) to the selection.
 * Modes also allow left-click move/attack/gather for touch users.
 */
export class InputControllerImpl implements InputController {
  private mode: InputMode = 'selection'
  private world: World | null = null
  private renderer: Renderer | null = null
  private selected: number[] = []
  private dragStart: { x: number; y: number } | null = null
  private panning = false

  attach(canvas: HTMLCanvasElement, world: World, renderer: Renderer): void {
    this.world = world
    this.renderer = renderer
    canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    canvas.addEventListener('pointermove', (e) => this.onMove(e))
    canvas.addEventListener('pointerup', (e) => this.onUp(e))
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  setMode(mode: InputMode): void {
    this.mode = mode
  }

  getMode(): InputMode {
    return this.mode
  }

  /** Legacy entry: treat as a left-click at canvas pixel position. */
  handlePointer(position: readonly [number, number]): void {
    this.clickSelect(position[0], position[1])
  }

  getSelected(): number[] {
    return [...this.selected]
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return
    this.dragStart = { x: e.offsetX, y: e.offsetY }
    this.panning = false
  }

  private onMove(e: PointerEvent): void {
    if (!this.dragStart || !this.renderer) return
    const dx = e.offsetX - this.dragStart.x
    const dy = e.offsetY - this.dragStart.y
    if (!this.panning && Math.hypot(dx, dy) > 6) this.panning = true
    if (this.panning) {
      this.renderer.pan(e.movementX, e.movementY)
      this.dragStart = { x: e.offsetX, y: e.offsetY }
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 2) {
      this.smartOrder(e.offsetX, e.offsetY)
      return
    }
    if (e.button !== 0) return
    const wasPan = this.panning
    this.dragStart = null
    this.panning = false
    if (wasPan) return
    if (this.mode === 'selection') this.clickSelect(e.offsetX, e.offsetY)
    else this.modeOrder(e.offsetX, e.offsetY)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    this.renderer?.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX, e.offsetY)
  }

  /** Select the nearest player entity under the cursor. */
  private clickSelect(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const p = renderer.screenToWorld(sx, sy)
    let best = -1
    let bestDist = PICK_RADIUS
    for (const id of world.entities.keys()) {
      if (world.team[id] !== TEAM_PLAYER) continue
      if (!world.isAttackable(id)) continue
      const d = Math.hypot(world.positionX[id] - p.x, world.positionZ[id] - p.z)
      if (d < bestDist) {
        bestDist = d
        best = id
      }
    }
    this.selected = best === -1 ? [] : [best]
    renderer.setSelection(this.selected)
  }

  /** Left-click order in move/attack/gather mode. */
  private modeOrder(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer || this.selected.length === 0) return
    const p = renderer.screenToWorld(sx, sy)
    const target = this.entityAt(p.x, p.z)
    if (this.mode === 'move') {
      for (const id of this.selected) orderMove(world, id, p.x, p.z)
    } else if (this.mode === 'attack' && target !== -1) {
      for (const id of this.selected) orderAttack(world, id, target)
    } else if (this.mode === 'gather' && target !== -1) {
      this.assignGather(world, target)
    }
    this.setMode('selection')
  }

  /** Right-click: attack enemies, gather from nodes, move otherwise. */
  private smartOrder(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer || this.selected.length === 0) return
    const p = renderer.screenToWorld(sx, sy)
    const target = this.entityAt(p.x, p.z, true)
    if (target !== -1 && world.team[target] !== TEAM_PLAYER && world.isAttackable(target)) {
      for (const id of this.selected) orderAttack(world, id, target)
      return
    }
    if (target !== -1 && (world.kind[target] === KIND_TREE || world.kind[target] === KIND_GOLDMINE)) {
      this.assignGather(world, target)
      return
    }
    for (const id of this.selected) {
      if (world.kind[id] <= KIND_RANGED) orderMove(world, id, p.x, p.z)
    }
  }

  private assignGather(world: World, node: number): void {
    const want = world.kind[node] === KIND_TREE ? HARVEST_WOOD : HARVEST_GOLD
    for (const id of this.selected) {
      if (world.kind[id] !== KIND_WORKER) continue
      world.harvestKind[id] = want
      orderGather(world, id)
    }
  }

  /** Nearest entity to a world point; enemies included when `anyTeam`. */
  private entityAt(x: number, z: number, anyTeam = false): number {
    const world = this.world
    if (!world) return -1
    let best = -1
    let bestDist = PICK_RADIUS
    for (const id of world.entities.keys()) {
      if (!anyTeam && world.team[id] !== TEAM_PLAYER) continue
      const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z) - world.radius[id]
      if (d < bestDist) {
        bestDist = d
        best = id
      }
    }
    return best
  }
}
