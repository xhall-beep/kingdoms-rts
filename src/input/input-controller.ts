import type { World } from '../core/World'
import {
  CARRY_NONE,
  HARVEST_GOLD,
  HARVEST_WOOD,
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_TREE,
  KIND_WORKER,
  STATE_IDLE,
  TEAM_PLAYER,
} from '../core/World'
import { orderStop } from '../systems/movement.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { Command } from '../session/commands.ts'
import type { Renderer } from '../render/renderer'
import { sfx } from '../ui/feedback.ts'
import { canPlaceStructure, placeStructure } from '../world/construction.ts'
import { orderAttack, orderAttackMove } from '../systems/combat'
import { orderBuild, orderGather } from '../systems/gather'
import { setRally } from '../systems/production.ts'
import { orderMove, orderHold, orderPatrol } from '../systems/movement'

export type InputMode = 'selection' | 'move' | 'attack' | 'gather' | 'build' | 'patrol'

export interface InputController {
  setMode(mode: InputMode): void
  getMode(): InputMode
  handlePointer(position: readonly [number, number]): void
  /** Jump the camera to the local team's town hall (phone "I'm lost" recovery). */
  centerOnBase(): void
  /** Would the pending building actually place at the current ghost spot? */
  isGhostValid(world: World): boolean
}

const PICK_RADIUS_PX = 40 // minimum tap target in screen pixels (finger-friendly)

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
  private dragStart: { x: number; y: number; pointerType: string } | null = null
  private panning = false
  private boxSelecting = false
  private pointers = new Map<number, { x: number; y: number }>()
  private pendingBuilding: BuildingType | null = null
  private ghostPos: { x: number; z: number } | null = null
  private commandListener: ((cmd: Command) => void) | null = null
  /** Team treated as "us" for selection/enemy checks (PvP: our slot). */
  private localTeam: 0 | 1 = TEAM_PLAYER
  /**
   * When true, input only emits commands without mutating the world.
   * Used for lockstep PvP: commands take effect when the turn executes.
   */
  private deferred = false

  /** Swap the world without rebinding canvas listeners (PvP transition). */
  setWorld(world: World): void {
    this.world = world
    this.selected = []
    this.pendingBuilding = null
    this.ghostPos = null
  }

  setLocalTeam(team: 0 | 1): void {
    this.localTeam = team
  }

  setDeferredExecution(deferred: boolean): void {
    this.deferred = deferred
  }

  attach(canvas: HTMLCanvasElement, world: World, renderer: Renderer): void {
    this.world = world
    this.renderer = renderer
    canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    canvas.addEventListener('pointermove', (e) => this.onMove(e))
    canvas.addEventListener('pointerup', (e) => this.onUp(e))
    canvas.addEventListener('pointercancel', (e) => this.onCancel(e))
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  setMode(mode: InputMode): void {
    this.mode = mode
    this.updateModeBanner()
  }

  getMode(): InputMode {
    return this.mode
  }

  /** Legacy entry: treat as a left-click at canvas pixel position. */
  handlePointer(position: readonly [number, number]): void {
    this.tapSelect(position[0], position[1])
  }

  /**
   * Jump the camera to the local team's town hall (falling back to any own
   * unit, then the default base corner). Phone players can lose the camera
   * in unexplored dark map with no way back — this is the way back.
   */
  centerOnBase(): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    let bx = -40
    let bz = -40
    let found = false
    for (const id of world.entities.keys()) {
      if (world.team[id] === this.localTeam && world.kind[id] === KIND_HALL) {
        bx = world.positionX[id]
        bz = world.positionZ[id]
        found = true
        break
      }
    }
    if (!found) {
      for (const id of world.entities.keys()) {
        if (world.team[id] === this.localTeam) {
          bx = world.positionX[id]
          bz = world.positionZ[id]
          found = true
          break
        }
      }
    }
    if (found) renderer.centerOn(bx, bz, 8)
  }

  getSelected(): number[] {
    return [...this.selected]
  }

  /**
   * Select a player building of the given kind (Stormgate/AoE4-style quick select).
   * Tapping again cycles through multiple buildings of the same kind.
   * Does not move the camera.
   */
  selectBuilding(kind: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const matches: number[] = []
    for (const id of world.entities.keys()) {
      if (world.team[id] === this.localTeam && world.kind[id] === kind) matches.push(id)
    }
    if (matches.length === 0) return
    // Cycle: if currently selecting one of this kind, pick the next.
    let next = matches[0]
    if (this.selected.length === 1) {
      const idx = matches.indexOf(this.selected[0])
      if (idx !== -1) next = matches[(idx + 1) % matches.length]
    }
    this.selected = [next]
    renderer.setSelection(this.selected)
  }

  /**
   * Select all idle player workers (classic RTS idle-worker button).
   * A worker is idle when in STATE_IDLE and not carrying resources.
   */
  selectIdleWorkers(): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const idle: number[] = []
    for (const id of world.entities.keys()) {
      if (
        world.team[id] === this.localTeam &&
        world.kind[id] === KIND_WORKER &&
        world.state[id] === STATE_IDLE &&
        world.carryKind[id] === CARRY_NONE
      ) {
        idle.push(id)
      }
    }
    this.selected = idle
    renderer.setSelection(this.selected)
  }

  /** Stop all selected units: cancel movement, attacks, and other orders. */
  stopSelected(): void {
    const world = this.world
    if (!world) return
    const ids = this.selected.filter(
      (id) => world.team[id] === this.localTeam && world.kind[id] <= KIND_RANGED,
    )
    if (this.deferred) {
      if (ids.length > 0) this.emit({ type: 'stop', step: 0, unitIds: [...ids] })
      return
    }
    for (const id of ids) orderStop(world, id)
  }

  /** Order selected units to hold position. */
  holdSelected(): void {
    const world = this.world
    if (!world) return
    if (this.deferred) {
      if (this.selected.length > 0) this.emit({ type: 'hold', step: 0, unitIds: [...this.selected] })
      return
    }
    for (const id of this.selected) {
      orderHold(world, id)
    }
    sfx.move()
  }

  /** All building kinds the player currently owns (for the quick-select bar). */
  getOwnedBuildingKinds(): { kind: number; count: number }[] {
    const world = this.world
    if (!world) return []
    const counts = new Map<number, number>()
    for (const id of world.entities.keys()) {
      if (world.team[id] !== this.localTeam) continue
      const k = world.kind[id]
      if (k === KIND_HALL || k === KIND_BARRACKS || k === KIND_ARCHERY || k === KIND_FARM) {
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
    // Fixed order: hall, barracks, archery, farm.
    const order = [KIND_HALL, KIND_BARRACKS, KIND_ARCHERY, KIND_FARM]
    return order
      .filter((k) => counts.has(k))
      .map((k) => ({ kind: k, count: counts.get(k)! }))
  }

  /** Choose which building the next 'build'-mode tap will place. */
  /** Show/hide a build-mode banner. */
  private updateModeBanner(): void {
    let banner = document.getElementById('build-mode-banner')
    if (this.mode === 'build' && this.pendingBuilding) {
      if (!banner) {
        banner = document.createElement('div')
        banner.id = 'build-mode-banner'
        banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#f5c542;color:#102b2b;padding:8px 16px;border-radius:8px;font-weight:bold;z-index:9999;pointer-events:none;'
        document.body.appendChild(banner)
      }
      banner.textContent = `Tap map to place ${this.pendingBuilding}`
      banner.hidden = false
    } else if (banner) {
      banner.hidden = true
    }
  }

  setPendingBuilding(type: BuildingType | null): void {
    this.pendingBuilding = type
    if (type !== null) this.setMode('build')
    this.updateModeBanner()
  }

  getPendingBuilding(): BuildingType | null {
    return this.pendingBuilding
  }

  /** Current ghost preview position in world coords (build mode). */
  getGhostPosition(): { x: number; z: number } | null {
    return this.ghostPos
  }

  /** Receive every player-issued command (for the command log / replays). */
  setCommandListener(listener: ((cmd: Command) => void) | null): void {
    this.commandListener = listener
  }

  private emit(cmd: Command): void {
    this.commandListener?.(cmd)
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
    if (this.pointers.size === 1) {
      this.dragStart = { x: e.offsetX, y: e.offsetY, pointerType: e.pointerType }
      this.panning = false
      this.boxSelecting = false
    } else {
      // Second finger: switch to two-finger pan, cancel box select.
      this.boxSelecting = false
      this.panning = true
      this.renderer?.setSelectionBox(null)
    }
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId)
    if (!prev) return
    // movementX/Y are 0 (or unreliable) for touch pointers — derive the
    // per-event delta from the last tracked position so drag-pan and
    // two-finger pan actually work on phones.
    const mdx = e.offsetX - prev.x
    const mdy = e.offsetY - prev.y
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
    if (!this.renderer) return
    // Update build ghost preview.
    if (this.mode === 'build' && this.pendingBuilding) {
      const p = this.renderer.screenToWorld(e.offsetX, e.offsetY)
      this.ghostPos = { x: p.x, z: p.z }
    } else {
      this.ghostPos = null
    }

    if (this.pointers.size >= 2) {
      // Two-finger pan.
      this.renderer.pan(mdx, mdy)
      this.dragStart = null
      return
    }

    if (!this.dragStart) return
    const dx = e.offsetX - this.dragStart.x
    const dy = e.offsetY - this.dragStart.y
    const dist = Math.hypot(dx, dy)

    // In selection mode a drag becomes a box-select; otherwise it pans.
    if (this.mode === 'selection' && !this.panning && dist > this.dragThreshold()) {
      this.boxSelecting = true
    }
    if (this.boxSelecting) {
      this.renderer.setSelectionBox({
        x0: this.dragStart.x,
        y0: this.dragStart.y,
        x1: e.offsetX,
        y1: e.offsetY,
      })
      return
    }
    if (!this.panning && dist > this.dragThreshold()) this.panning = true
    if (this.panning) {
      this.renderer.pan(mdx, mdy)
      this.dragStart = { x: e.offsetX, y: e.offsetY, pointerType: this.dragStart?.pointerType ?? e.pointerType }
    }
  }

  /**
   * Tap-vs-drag slop: fingers are imprecise, so touch gets a wider
   * threshold than mouse before a press becomes a drag/pan/box-select.
   */
  private dragThreshold(): number {
    return this.dragStart?.pointerType === 'touch' ? 16 : 8
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId)
    if (e.button === 2) {
      this.smartOrder(e.offsetX, e.offsetY)
      return
    }
    if (e.button !== 0) return

    const wasBox = this.boxSelecting
    const wasPan = this.panning
    const start = this.dragStart
    this.dragStart = null
    this.panning = false
    this.boxSelecting = false
    this.renderer?.setSelectionBox(null)

    // Another finger still down: ignore this release.
    if (this.pointers.size > 0) return

    if (wasBox && start) {
      this.boxSelect(start.x, start.y, e.offsetX, e.offsetY)
      return
    }
    if (wasPan) return

    // Tap.
    if (this.mode === 'selection') {
      this.tapSelect(e.offsetX, e.offsetY)
    } else if (this.selected.length === 0) {
      this.tapSelect(e.offsetX, e.offsetY)
    } else {
      this.modeOrder(e.offsetX, e.offsetY)
    }
  }

  /**
   * The OS can interrupt a touch mid-gesture (notification shade, system
   * gesture) and fire pointercancel instead of pointerup. Without cleanup
   * the stale pointer stays in the map forever: every later tap looks like
   * a second finger, so taps silently die until reload. A cancel never
   * issues orders — it just resets the gesture state.
   */
  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId)
    if (this.pointers.size > 0) return
    this.dragStart = null
    this.panning = false
    this.boxSelecting = false
    this.renderer?.setSelectionBox(null)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    this.renderer?.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX, e.offsetY)
  }

  /** Tap: select entities for info/commands, or smart-order the selection. */
  private tapSelect(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const p = renderer.screenToWorld(sx, sy)
    const hit = this.entityAt(p.x, p.z, true)

    if (hit === -1) {
      // Empty ground: order selected units, or deselect.
      if (this.hasUnitsSelected(world)) {
        this.smartOrder(sx, sy)
      } else {
        this.selected = []
        renderer.setSelection(this.selected)
      }
      return
    }

    const isOwn = world.team[hit] === this.localTeam
    if (isOwn) {
      // Own entity: select it; tapping the sole selection deselects.
      if (this.selected.length === 1 && this.selected[0] === hit) {
        this.selected = []
        sfx.deselect()
      } else {
        this.selected = [hit]
        sfx.select()
      }
      renderer.setSelection(this.selected)
      return
    }

    // Enemy or resource: if we have units selected, smart-order (attack/gather).
    // Otherwise select it for info viewing.
    if (this.hasUnitsSelected(world)) {
      this.smartOrder(sx, sy)
    } else {
      if (this.selected.length === 1 && this.selected[0] === hit) {
        this.selected = []
        sfx.deselect()
      } else {
        this.selected = [hit]
        sfx.select()
      }
      renderer.setSelection(this.selected)
    }
  }

  /** Drag box in selection mode: select all own units inside the rectangle. */
  private boxSelect(x0: number, y0: number, x1: number, y1: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const a = renderer.screenToWorld(Math.min(x0, x1), Math.min(y0, y1))
    const b = renderer.screenToWorld(Math.max(x0, x1), Math.max(y0, y1))
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    const minZ = Math.min(a.z, b.z)
    const maxZ = Math.max(a.z, b.z)
    const inside: number[] = []
    // Spatial hash rect query instead of a full entity scan.
    world.spatialHash.forEachInRect(minX, minZ, maxX, maxZ, (id) => {
      if (world.team[id] !== this.localTeam) return
      const k = world.kind[id]
      if (k !== KIND_WORKER && k !== KIND_MELEE && k !== KIND_RANGED) return
      const x = world.positionX[id]
      const z = world.positionZ[id]
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) inside.push(id)
    })
    this.selected = inside
    renderer.setSelection(this.selected)
  }

  private hasUnitsSelected(world: World): boolean {
    for (const id of this.selected) {
      const k = world.kind[id]
      if (k === KIND_WORKER || k === KIND_MELEE || k === KIND_RANGED) return true
    }
    return false
  }

  /** Left-click order in move/attack/gather/build mode. */
  private modeOrder(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer || this.selected.length === 0) return
    const p = renderer.screenToWorld(sx, sy)
    // anyTeam MUST be true here: with the own-team filter, attack mode could
    // never see an enemy (every tap degraded to attack-move) and gather mode
    // could never see a resource node for the slot-1 player (nodes carry
    // team 0) — both buttons silently did the wrong thing or nothing.
    const target = this.entityAt(p.x, p.z, true)
    let keepMode = false
    if (this.mode === 'move') {
      if (this.selected.length === 1 && this.isProductionBuilding(world, this.selected[0])) {
        if (!this.deferred) setRally(world, this.selected[0], p.x, p.z)
        this.emit({ type: 'rally', step: 0, buildingId: this.selected[0], x: p.x, z: p.z })
      } else {
        if (!this.deferred) for (const id of this.selected) orderMove(world, id, p.x, p.z)
        this.renderer?.pingMove(p.x, p.z)
        this.emit({ type: 'move', step: 0, unitIds: [...this.selected], x: p.x, z: p.z })
      }
    } else if (this.mode === 'attack') {
      if (target !== -1 && world.team[target] !== this.localTeam && world.isAttackable(target)) {
        if (!this.deferred) for (const id of this.selected) orderAttack(world, id, target)
        this.renderer?.pingAttack(world.positionX[target], world.positionZ[target])
        this.emit({ type: 'attack', step: 0, unitIds: [...this.selected], targetId: target })
      } else {
        const fighters = this.selected.filter(
          (id) => world.kind[id] === KIND_MELEE || world.kind[id] === KIND_RANGED,
        )
        if (!this.deferred) for (const id of fighters) orderAttackMove(world, id, p.x, p.z)
        this.renderer?.pingAttack(p.x, p.z)
        if (fighters.length > 0) {
          this.emit({ type: 'attackmove', step: 0, unitIds: fighters, x: p.x, z: p.z })
        }
      }
    } else if (this.mode === 'gather') {
      if (target !== -1 && (world.kind[target] === KIND_TREE || world.kind[target] === KIND_GOLDMINE)) {
        this.assignGather(world, target)
      } else {
        // Not a resource node: acknowledge the tap instead of silently
        // swallowing it, and stay in gather mode for the next tap.
        sfx.error()
        keepMode = true
      }
    } else if (this.mode === 'build' && this.pendingBuilding !== null) {
      this.placeBuilding(p.x, p.z)
    } else if (this.mode === 'patrol') {
      if (!this.deferred) for (const id of this.selected) orderPatrol(world, id, p.x, p.z)
      this.emit({ type: 'patrol', step: 0, unitIds: [...this.selected], x: p.x, z: p.z })
    }
    if (this.mode !== 'build' && !keepMode) { this.setMode('selection'); this.ghostPos = null }
  }

  /** Place the pending building at a world point and send a selected worker. */
  private placeBuilding(x: number, z: number): void {
    const world = this.world
    const type = this.pendingBuilding
    if (!world || type === null) return
    const worker = this.selected.find((id) => world.kind[id] === KIND_WORKER)
    if (worker === undefined) {
      // No builder selected: acknowledge the tap instead of swallowing it.
      sfx.error()
      return
    }
    if (this.deferred) {
      // Lockstep PvP: the turn executor places the structure deterministically.
      this.emit({ type: 'build', step: 0, workerId: worker, building: type, x, z, siteId: -1 })
      return
    }
    const placed = placeStructure(world, this.localTeam, type, x, z)
    if (placed.ok) {
      orderBuild(world, worker, placed.id)
      this.emit({ type: 'build', step: 0, workerId: worker, building: type, x, z, siteId: placed.id })
      // Stay in build mode for placing more; the HUD can cancel.
    } else {
      // Blocked footprint / can't afford / faction rule: say so audibly —
      // a silent no-op here reads as "the game ignored my tap".
      sfx.error()
    }
  }

  /** Would the pending building place at the current ghost position? */
  isGhostValid(world: World): boolean {
    if (this.pendingBuilding === null || this.ghostPos === null) return true
    return canPlaceStructure(world, this.localTeam, this.pendingBuilding, this.ghostPos.x, this.ghostPos.z)
  }

  /** Right-click: attack enemies, gather from nodes, move otherwise. */
  private smartOrder(sx: number, sy: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer || this.selected.length === 0) return
    const p = renderer.screenToWorld(sx, sy)
    const target = this.entityAt(p.x, p.z, true)
    if (target !== -1 && world.team[target] !== this.localTeam && world.isAttackable(target)) {
      for (const id of this.selected) orderAttack(world, id, target)
      this.renderer?.pingAttack(world.positionX[target], world.positionZ[target])
      this.emit({ type: 'attack', step: 0, unitIds: [...this.selected], targetId: target })
      sfx.attack()
      return
    }
    if (target !== -1 && (world.kind[target] === KIND_TREE || world.kind[target] === KIND_GOLDMINE)) {
      this.assignGather(world, target)
      return
    }
    const movers = this.selected.filter((id) => world.kind[id] <= KIND_RANGED)
    if (!this.deferred) for (const id of movers) orderMove(world, id, p.x, p.z)
    this.renderer?.pingMove(p.x, p.z)
    this.emit({ type: 'move', step: 0, unitIds: movers, x: p.x, z: p.z })
    if (movers.length > 0) sfx.move()
  }

  private isProductionBuilding(world: World, id: number): boolean {
    const k = world.kind[id]
    return k === KIND_HALL || k === KIND_BARRACKS || k === KIND_ARCHERY
  }

  private assignGather(world: World, node: number): void {
    const want = world.kind[node] === KIND_TREE ? HARVEST_WOOD : HARVEST_GOLD
    const workers = this.selected.filter((id) => world.kind[id] === KIND_WORKER)
    if (!this.deferred) for (const id of workers) {
      world.harvestKind[id] = want
      orderGather(world, id)
    }
    if (workers.length > 0) {
      this.emit({ type: 'gather', step: 0, unitIds: workers, nodeId: node })
      // Visible acknowledgment at the node — a gather order used to be the
      // one order with no on-map feedback at all.
      this.renderer?.pingMove(world.positionX[node], world.positionZ[node])
      sfx.gather()
    }
  }

  /** Nearest entity to a world point; enemies included when `anyTeam`. */
  private entityAt(x: number, z: number, anyTeam = false): number {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return -1
    let best = -1
    let bestDist = PICK_RADIUS_PX / renderer.getZoom()
    // Spatial hash: pick radius is a few world units, well within 3x3 cells.
    world.spatialHash.forEachNear(x, z, (id) => {
      if (!anyTeam && world.team[id] !== this.localTeam) return
      const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z) - world.radius[id]
      if (d < bestDist) {
        bestDist = d
        best = id
      }
    })
    return best
  }
}
