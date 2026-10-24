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

// --- Selection gesture tuning (touch, selection mode) ---
// One finger must both pan the camera and draw a marquee; the conflict is
// resolved by intent, not by a mode toggle:
//   * a drag that STARTS on a friendly unit is a marquee (past the dead zone);
//   * a QUICK drag anywhere else pans (past the pan threshold, before the
//     hold window elapses);
//   * a press HELD for HOLD_ARM_MS arms the marquee, so a deliberate slow
//     drag boxes instead of panning;
//   * releasing a held press on empty ground without dragging is an aborted
//     marquee — never a move order.
const DEAD_ZONE_PX = 10 // press slop: movement inside this starts nothing
const PAN_THRESHOLD_PX = 16 // quick-drag distance that commits to a camera pan
const HOLD_ARM_MS = 200 // press-and-hold that arms the marquee
const LONG_PRESS_MS = 450 // press-and-hold on an own unit: select all of its kind on screen
const DOUBLE_TAP_MS = 320 // second tap within this window on the same unit kind…
const DOUBLE_TAP_RADIUS_PX = 40 // …and within this screen distance: select all of its kind on screen

/** Unit kinds the player can select/order (buildings and nodes are not units). */
function isUnitKind(kind: number): boolean {
  return kind === KIND_WORKER || kind === KIND_MELEE || kind === KIND_RANGED
}

/** Event timestamp, coerced: synthetic events in tests may omit it. */
function timeOf(e: PointerEvent): number {
  return typeof e.timeStamp === 'number' ? e.timeStamp : 0
}

export interface PinchStep {
  /** Zoom multiplier: ratio of the new inter-pointer distance to the old. */
  factor: number
  /** Gesture midpoint after the move — the zoom anchor point. */
  midX: number
  midY: number
  /** Midpoint movement since the previous event — the pan component. */
  panDx: number
  panDy: number
}

/**
 * Pure two-pointer gesture math. Given both pointers' positions before and
 * after a move, returns how the camera should respond: spreading the
 * fingers (distance grows) zooms in about the midpoint; a constant-
 * distance two-finger drag yields factor 1 and pans by the midpoint delta.
 * Kept pure and exported so the gesture math is unit-testable without a DOM.
 */
export function pinchStep(
  prevA: { x: number; y: number },
  prevB: { x: number; y: number },
  nextA: { x: number; y: number },
  nextB: { x: number; y: number },
): PinchStep {
  const prevDist = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y)
  const nextDist = Math.hypot(nextB.x - nextA.x, nextB.y - nextA.y)
  const prevMidX = (prevA.x + prevB.x) / 2
  const prevMidY = (prevA.y + prevB.y) / 2
  const nextMidX = (nextA.x + nextB.x) / 2
  const nextMidY = (nextA.y + nextB.y) / 2
  return {
    factor: prevDist > 0 && nextDist > 0 ? nextDist / prevDist : 1,
    midX: nextMidX,
    midY: nextMidY,
    panDx: nextMidX - prevMidX,
    panDy: nextMidY - prevMidY,
  }
}

/**
 * Pointer input: tap selects, right-click issues smart orders (move /
 * attack / gather), two-finger drag pans and pinch zooms (touch), wheel
 * zooms. One-finger gestures in selection mode are disambiguated by
 * intent (see the tuning constants above): drag from a friendly unit or
 * hold-then-drag draws a marquee box-select, a quick drag elsewhere pans
 * the camera. Double-tap or long-press on a unit selects every unit of
 * that kind currently on screen. Modes also allow left-click
 * move/attack/gather for touch users.
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
  /**
   * Latched while a two-pointer gesture (pan/pinch) is in progress, so the
   * final finger release that ends it is never misread as a tap.
   */
  private multiTouch = false
  /** Press bookkeeping for the pending (undecided) single-pointer gesture. */
  private downTime = 0
  private downHit = -1
  private downHitKind = -1
  /** Long-press fired mid-press: the rest of this gesture is inert. */
  private gestureConsumed = false
  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  /** True once attach() bound real canvas listeners (enables the hold timer). */
  private attached = false
  /** Previous unit tap, for double-tap select-all-of-kind detection. */
  private lastTap: { t: number; x: number; y: number; kind: number } | null = null
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
    this.lastTap = null
    this.downHit = -1
    this.downHitKind = -1
    this.clearLongPressTimer()
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
    this.attached = true
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
    if (found) renderer.centerOn(bx, bz, 10)
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
      this.gestureConsumed = false
      this.downTime = timeOf(e)
      this.downHit = -1
      this.downHitKind = -1
      // What did the press land on? Gesture intent (marquee-from-unit,
      // long-press type-select) is decided from this, once, at press time.
      if (this.mode === 'selection' && this.world && this.renderer) {
        const p = this.renderer.screenToWorld(e.offsetX, e.offsetY)
        const hit = this.entityAt(p.x, p.z, true)
        if (hit !== -1) {
          this.downHit = hit
          this.downHitKind = this.world.kind[hit]
        }
      }
      this.armLongPressTimer()
    } else {
      // Second finger: switch to a two-finger gesture (pan + pinch zoom),
      // cancel any box select, and latch it so the releases that end the
      // gesture don't fire a phantom tap.
      this.multiTouch = true
      this.boxSelecting = false
      this.panning = true
      this.clearLongPressTimer()
      this.renderer?.setSelectionBox(null)
    }
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  }

  /**
   * Long-press on an own unit selects all of its kind on screen. The timer
   * fires while the finger is still down (production path, attach() only);
   * onUp carries the same check by press duration so the behavior is
   * identical headless. Fires at most once per press: it consumes the
   * gesture, so the eventual release is inert.
   */
  private armLongPressTimer(): void {
    this.clearLongPressTimer()
    if (!this.attached) return
    if (this.mode !== 'selection' || !this.isOwnUnit(this.downHit, this.downHitKind)) return
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null
      if (this.pointers.size !== 1 || this.gestureConsumed) return
      if (this.panning || this.boxSelecting || this.mode !== 'selection') return
      if (!this.isOwnUnit(this.downHit, this.downHitKind)) return
      this.gestureConsumed = true
      this.lastTap = null
      this.selectAllOfKindOnScreen(this.downHitKind)
    }, LONG_PRESS_MS)
  }

  /** Is `id` (with the kind recorded for it) still one of our units? */
  private isOwnUnit(id: number, kind: number): boolean {
    const world = this.world
    return (
      !!world &&
      id >= 0 &&
      isUnitKind(kind) &&
      world.team[id] === this.localTeam &&
      world.kind[id] === kind
    )
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId)
    if (!prev) return
    // movementX/Y are 0 (or unreliable) for touch pointers — derive the
    // per-event delta from the last tracked position so drag-pan and
    // two-finger gestures actually work on phones.
    const mdx = e.offsetX - prev.x
    const mdy = e.offsetY - prev.y
    // Snapshot both pointers BEFORE applying this event, for pinch math.
    const before = this.pointers.size >= 2 ? [...this.pointers.values()] : null
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
      // Two-finger gesture: pinch (inter-pointer distance change) zooms
      // about the gesture midpoint; a constant-distance drag pans by the
      // midpoint's movement. Before this, two fingers could only pan and
      // touch had NO zoom at all — zoomBy was reachable only via wheel.
      const after = [...this.pointers.values()]
      if (before && after.length >= 2) {
        const movedIdx = [...this.pointers.keys()].indexOf(e.pointerId)
        const otherIdx = movedIdx === 0 ? 1 : 0
        const step = pinchStep(
          before[movedIdx],
          before[otherIdx],
          after[movedIdx],
          after[otherIdx],
        )
        if (step.panDx !== 0 || step.panDy !== 0) this.renderer.pan(step.panDx, step.panDy)
        if (Math.abs(step.factor - 1) > 0.001) {
          this.renderer.zoomBy(step.factor, step.midX, step.midY)
        }
      }
      this.dragStart = null
      return
    }

    if (!this.dragStart) return
    if (this.gestureConsumed) return
    const dx = e.offsetX - this.dragStart.x
    const dy = e.offsetY - this.dragStart.y
    const dist = Math.hypot(dx, dy)

    if (this.boxSelecting) {
      this.renderer.setSelectionBox({
        x0: this.dragStart.x,
        y0: this.dragStart.y,
        x1: e.offsetX,
        y1: e.offsetY,
      })
      return
    }
    if (this.panning) {
      this.renderer.pan(mdx, mdy)
      this.dragStart = { x: e.offsetX, y: e.offsetY, pointerType: this.dragStart.pointerType }
      return
    }

    // Gesture still PENDING (inside the dead zone, or held without
    // committing): decide marquee vs pan exactly once, from intent.
    if (this.mode === 'selection' && this.dragStart.pointerType !== 'touch') {
      // Mouse/pen are precise: classic RTS — a drag is a marquee.
      if (dist > this.dragThreshold()) this.startBox(e)
      return
    }
    if (this.mode === 'selection') {
      // Touch, one finger, selection mode:
      //  - a drag starting on a friendly unit is a marquee;
      //  - a press held past HOLD_ARM_MS has armed the marquee;
      //  - anything quicker is a camera pan.
      if (this.isOwnUnit(this.downHit, this.downHitKind) && dist > DEAD_ZONE_PX) {
        this.startBox(e)
        return
      }
      if (timeOf(e) - this.downTime >= HOLD_ARM_MS) {
        this.startBox(e)
        return
      }
      if (dist > PAN_THRESHOLD_PX) this.startPan(e, mdx, mdy)
      return
    }
    // Non-selection modes: a drag pans (unchanged).
    if (dist > this.dragThreshold()) this.startPan(e, mdx, mdy)
  }

  /** Commit the pending gesture to a marquee box-select. */
  private startBox(e: PointerEvent): void {
    if (!this.dragStart || !this.renderer) return
    this.boxSelecting = true
    this.clearLongPressTimer()
    this.renderer.setSelectionBox({
      x0: this.dragStart.x,
      y0: this.dragStart.y,
      x1: e.offsetX,
      y1: e.offsetY,
    })
  }

  /** Commit the pending gesture to a camera pan. */
  private startPan(e: PointerEvent, mdx: number, mdy: number): void {
    if (!this.dragStart || !this.renderer) return
    this.panning = true
    this.clearLongPressTimer()
    this.renderer.pan(mdx, mdy)
    this.dragStart = { x: e.offsetX, y: e.offsetY, pointerType: this.dragStart.pointerType }
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
    const consumed = this.gestureConsumed
    const start = this.dragStart
    const downTime = this.downTime
    const downHit = this.downHit
    const downHitKind = this.downHitKind
    this.clearLongPressTimer()
    this.dragStart = null
    this.panning = false
    this.boxSelecting = false
    this.gestureConsumed = false
    this.downHit = -1
    this.downHitKind = -1
    this.renderer?.setSelectionBox(null)

    // Another finger still down: ignore this release.
    if (this.pointers.size > 0) return

    // The last release of a two-finger gesture (pan/pinch) is not a tap —
    // without this latch, lifting the second finger after a pinch would
    // also select/order at the lift point.
    if (this.multiTouch) {
      this.multiTouch = false
      return
    }

    // A long-press already fired mid-press and consumed this gesture.
    if (consumed) return

    if (wasBox && start) {
      this.boxSelect(start.x, start.y, e.offsetX, e.offsetY)
      return
    }
    if (wasPan) return

    // The press never became a pan or a marquee: it resolves as a tap, a
    // long-press, or an aborted hold, by duration and what it landed on.
    const now = timeOf(e)
    if (this.mode === 'selection' && start) {
      const duration = now - downTime
      const drift = Math.hypot(e.offsetX - start.x, e.offsetY - start.y)
      if (
        duration >= LONG_PRESS_MS &&
        drift <= DEAD_ZONE_PX * 2 &&
        this.isOwnUnit(downHit, downHitKind)
      ) {
        // Long-press on a unit (release-path twin of the hold timer).
        this.lastTap = null
        this.selectAllOfKindOnScreen(downHitKind)
        return
      }
      if (downHit === -1 && duration >= HOLD_ARM_MS) {
        // Held on empty ground to arm a marquee, then released without
        // dragging: an aborted marquee. NOT a tap — it must not turn
        // into a move order or a deselect.
        return
      }
    }

    // Tap.
    if (this.mode === 'selection') {
      this.tapSelect(e.offsetX, e.offsetY, now)
    } else if (this.selected.length === 0) {
      this.tapSelect(e.offsetX, e.offsetY, now)
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
    this.clearLongPressTimer()
    this.dragStart = null
    this.panning = false
    this.boxSelecting = false
    this.multiTouch = false
    this.gestureConsumed = false
    this.downHit = -1
    this.downHitKind = -1
    this.renderer?.setSelectionBox(null)
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    this.renderer?.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX, e.offsetY)
  }

  /** Tap: select entities for info/commands, or smart-order the selection. */
  private tapSelect(sx: number, sy: number, now = 0): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const p = renderer.screenToWorld(sx, sy)
    const hit = this.entityAt(p.x, p.z, true)

    if (hit === -1) {
      if (now > 0) this.lastTap = null
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
      // Double-tap on a unit: select every unit of that kind on screen.
      // It deliberately replaces the tap-again-to-deselect toggle, but
      // only inside the double-tap window — a slower second tap still
      // toggles as before.
      if (now > 0 && isUnitKind(world.kind[hit])) {
        if (this.tryDoubleTap(now, sx, sy, world.kind[hit])) return
        this.lastTap = { t: now, x: sx, y: sy, kind: world.kind[hit] }
      } else if (now > 0) {
        this.lastTap = null
      }
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
    if (now > 0) this.lastTap = null
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

  /**
   * Double-tap check: the previous tap hit a unit of the same kind,
   * recently, and nearby on screen. On a match, select all of that kind
   * on screen and consume the tap chain.
   */
  private tryDoubleTap(now: number, sx: number, sy: number, kind: number): boolean {
    const lt = this.lastTap
    if (!lt || lt.kind !== kind) return false
    if (now - lt.t > DOUBLE_TAP_MS) return false
    if (Math.hypot(sx - lt.x, sy - lt.y) > DOUBLE_TAP_RADIUS_PX) return false
    this.lastTap = null
    this.selectAllOfKindOnScreen(kind)
    return true
  }

  /**
   * Select every own unit of `kind` inside the camera's current view
   * (double-tap / long-press on a unit). "On screen" is the renderer's
   * visible world rectangle — units a screen-edge away are excluded even
   * if they are the same kind.
   */
  private selectAllOfKindOnScreen(kind: number): void {
    const world = this.world
    const renderer = this.renderer
    if (!world || !renderer) return
    const size = renderer.getCssSize()
    const a = renderer.screenToWorld(0, 0)
    const b = renderer.screenToWorld(size.w, size.h)
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    const minZ = Math.min(a.z, b.z)
    const maxZ = Math.max(a.z, b.z)
    const picked: number[] = []
    world.spatialHash.forEachInRect(minX, minZ, maxX, maxZ, (id) => {
      if (world.team[id] !== this.localTeam || world.kind[id] !== kind) return
      const x = world.positionX[id]
      const z = world.positionZ[id]
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) picked.push(id)
    })
    if (picked.length === 0) return
    this.selected = picked
    renderer.setSelection(this.selected)
    sfx.select()
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
