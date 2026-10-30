import { FACTIONS } from '../data/factions.ts'
import { RESOURCES } from '../data/resources.ts'
import type { World, DeathPop } from '../core/World'
import { sfx } from '../ui/feedback.ts'
import {
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_SHRINE,
  KIND_SMITHY,
  KIND_TREE,
  KIND_TREANT,
  KIND_WORKER,
  KIND_TOWER,
  KIND_WORKSHOP,
  STATE_IDLE,
  HARVEST_OFF,
  isBuildingKind,
} from '../core/World'
import { FOG_UNEXPLORED, FOG_VISIBLE } from '../world/fog.ts'
import {
  LUNGE_AMPLITUDE,
  LUNGE_DURATION,
  lungeProgress,
  squashFactors,
  strikeJustFired,
} from './motion.ts'
import { getSprite } from './sprites.ts'
import type { FogGrid } from '../world/fog.ts'
import { canSee } from '../world/visibility.ts'

const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

/**
 * Held-worker ("statue") condition, shared by the renderer marker and the
 * toolbar pulse: a worker that is idle, has auto-gather disarmed
 * (HARVEST_OFF — set by an explicit move order or by Stop), and carries
 * nothing. Such a worker will NEVER re-task itself: without a marker it
 * reads as frozen. Render-only; the sim never consults this.
 */
export function isHeldWorker(world: World, id: number): boolean {
  return (
    world.kind[id] === KIND_WORKER &&
    world.state[id] === STATE_IDLE &&
    world.harvestKind[id] === HARVEST_OFF &&
    world.carryAmount[id] === 0
  )
}

/** Sprite key per entity kind (Human faction). Null = procedural. */
const SPRITE_FOR_KIND: Record<number, string | null> = {
  [KIND_HALL]: 'town_hall_l1',
  [KIND_FARM]: 'homestead_farm',
  [KIND_BARRACKS]: 'barracks',
  [KIND_TOWER]: 'guard_tower',
  [KIND_WORKSHOP]: 'workshop',
  [KIND_SMITHY]: 'smithy',
  // KIND_ARCHERY has no sprite: it renders the procedural pitched-roof
  // form, which stays visually distinct from the sprite buildings.
  // KIND_WORKER handled separately (unit rendering below)
}

/**
 * Ground + fog palette (visual-only; never enters the sim or the hash).
 *
 * The old ground was a flat #16241a fill — on a phone it read as a black
 * void, trees (green) vanished into it, and explored fog (45% near-black
 * over near-black) was indistinguishable from unexplored. The vision is a
 * golden-autumn woodland: muted gold-olive grass with per-cell variation,
 * autumn canopies, and explored fog that dims the terrain instead of
 * erasing it.
 */
export const GROUND_BASE = '#4c5a2a'
const GROUND_TINTS = ['#55622f', '#434e24', '#5a6533', '#6b5c2b'] as const
export const FOG_UNEXPLORED_FILL = '#070a07'
export const FOG_EXPLORED_FILL = 'rgba(10,14,18,0.38)'

/** Stable 0..1 hash of two integers (visual variation that never flickers). */
function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Ground tint for a 10-unit world cell: mostly the base, patches of variation. */
export function groundTintAt(cellX: number, cellZ: number): string {
  const r = hash2(cellX, cellZ)
  if (r < 0.45) return GROUND_BASE
  const idx = Math.min(GROUND_TINTS.length - 1, Math.floor(((r - 0.45) / 0.55) * GROUND_TINTS.length))
  return GROUND_TINTS[idx]
}

const TREE_CANOPY: ReadonlyArray<{ outer: string; inner: string }> = [
  { outer: '#b45f1d', inner: '#d98e3a' }, // amber
  { outer: '#c97a24', inner: '#e0a34a' }, // gold
  { outer: '#a34d1a', inner: '#c47a2e' }, // rust
  { outer: '#8f6b1f', inner: '#b8912f' }, // ochre
]

/** Autumn canopy colors for a tree at a world position (stable per tree). */
export function treeColorsAt(x: number, z: number): { outer: string; inner: string } {
  const idx = Math.floor(hash2(Math.round(x * 3), Math.round(z * 3)) * TREE_CANOPY.length)
  return TREE_CANOPY[Math.min(TREE_CANOPY.length - 1, idx)]
}

/**
 * 2D canvas renderer: terrain, fog-gated entities, health bars, selection,
 * and a fog-of-war overlay for the viewing team. Own camera (pan/zoom).
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private camX = 0
  private camZ = 0
  private zoom = 10
  private selected = new Set<number>()
  private selectionBox: { x0: number; y0: number; x1: number; y1: number } | null = null
  private frame = 0
  /**
   * CSS-pixel viewport size. The canvas backing store is cssSize * dpr, with
   * the context transform scaled by dpr, so ALL drawing and coordinate math
   * in this class works in CSS pixels — the same units pointer events use.
   * Mixing backing pixels into the math (e.g. sizing from a stale or
   * fallback canvas.width) shrinks the visible world and misroutes every
   * tap, which is exactly the Pixel black-screen + broken-tap bug.
   */
  private cssWidth = 0
  private cssHeight = 0
  // Fog is cached to an offscreen canvas (one px per cell) and rebuilt when
  // the fog revision changes or every 20 frames (whichever comes first);
  // per-frame we do a single drawImage instead of ~8k rects.
  private fogCache: (HTMLCanvasElement | null)[] = [null, null]
  private fogCacheFrame: number[] = [-1e9, -1e9]
  private fogCacheRevision: number[] = [-1, -1]
  /** Team this renderer is viewing (set each render call). */
  private viewTeam: 0 | 1 = 0
  /** Hit flashes: entity id -> age in seconds (visual-only, real-time). */
  private hitFlashes = new Map<number, number>()
  /**
   * Attack lunges: melee/militia striker id -> world-space unit direction
   * + age in seconds (visual-only, real-time). Set when the striker's
   * cooldown jumps up between renders — the sim's strike signature —
   * and aged out after LUNGE_DURATION. Never sim state, never hashed.
   */
  private lunges = new Map<number, { ux: number; uz: number; age: number }>()
  /** Last seen striker cooldown per entity, for strike detection. */
  private prevCooldown = new Map<number, number>()
  /** Death pops being animated (visual-only, real-time). */
  private deathPops: DeathPop[] = []
  /** Last loss-sfx time (performance.now), throttled so mass deaths stay quiet. */
  private lastLossSfx = 0
  /** Completion pops being animated: gold ring at finished buildings/units. */
  private completionPops: { x: number; z: number; age: number; r: number; unit: boolean }[] = []
  /** Last completion-sfx time (performance.now), throttled like loss stings. */
  private lastCompletionSfx = 0
  /** Last render dt in seconds; used to age hit flashes inside drawEntity. */
  private lastDt = 1 / 60

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context is unavailable')
    this.ctx = ctx
  }

  /**
   * Size the canvas to the CSS viewport. Backing store is scaled by
   * devicePixelRatio (capped at 3 for fill-rate safety on phones) so the
   * game stays crisp on high-DPI screens; the context transform keeps all
   * drawing math in CSS pixels. Must be called after layout settles and on
   * every viewport change (rotation, URL-bar show/hide) — a stale backing
   * size desyncs rendering from input.
   */
  resize(cssWidth: number, cssHeight: number): void {
    const w = Math.max(1, Math.round(cssWidth))
    const h = Math.max(1, Math.round(cssHeight))
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio
        ? Math.min(3, window.devicePixelRatio)
        : 1
    this.cssWidth = w
    this.cssHeight = h
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Changing the backing store resets the context, including the fog
    // cache positions — they rebuild automatically from revision/frame.
  }

  /** CSS-pixel viewport size (what pointer events and layout use). */
  getCssSize(): { w: number; h: number } {
    return { w: this.cssWidth, h: this.cssHeight }
  }

  setSelection(ids: number[]): void {
    this.selected = new Set(ids)
  }

  /** Drag-selection rectangle in screen pixels, or null to hide. */
  setSelectionBox(box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    this.selectionBox = box
  }

  getSelection(): number[] {
    return [...this.selected]
  }

  getZoom(): number {
    return this.zoom
  }

  /** Jump the camera to a world point. */
  centerOn(x: number, z: number, zoom?: number): void {
    this.camX = x
    this.camZ = z
    if (zoom !== undefined) this.zoom = Math.min(40, Math.max(2, zoom))
    this.clampCamera()
  }

  /**
   * True when a world point projects inside the current viewport.
   * The HUD alert chip decides display on this: an event the player
   * can already see raises no chip (flashes and rings cover it).
   * Before the first resize the viewport is unmeasured — report
   * off-screen so an alert is never silently swallowed.
   */
  isWorldPointOnScreen(x: number, z: number): boolean {
    if (this.cssWidth <= 0 || this.cssHeight <= 0) return false
    const s = this.toScreen(x, z)
    return s.x >= 0 && s.x <= this.cssWidth && s.y >= 0 && s.y <= this.cssHeight
  }

  pan(dxPixels: number, dyPixels: number): void {
    this.camX -= dxPixels / this.zoom
    this.camZ -= dyPixels / this.zoom
    this.clampCamera()
  }

  /**
   * Keep the camera near the world (the fog/world square is [-90, 90]²;
   * the margin lets the view centre sit past an edge so the edge itself
   * can be inspected). Without a clamp a player can pan into empty dark
   * indefinitely and lose the map entirely. Visual-only: the camera never
   * enters sim state or the lockstep hash.
   */
  private clampCamera(): void {
    const M = 170
    this.camX = Math.min(M, Math.max(-M, this.camX))
    this.camZ = Math.min(M, Math.max(-M, this.camZ))
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const px = cx ?? this.cssWidth / 2
    const py = cy ?? this.cssHeight / 2
    const before = this.screenToWorld(px, py)
    this.zoom = Math.min(40, Math.max(2, this.zoom * factor))
    const after = this.screenToWorld(px, py)
    this.camX += before.x - after.x
    this.camZ += before.z - after.z
    this.clampCamera()
  }

  screenToWorld(sx: number, sy: number): { x: number; z: number } {
    return {
      x: (sx - this.cssWidth / 2) / this.zoom + this.camX,
      z: (sy - this.cssHeight / 2) / this.zoom + this.camZ,
    }
  }

  private ghostBuilding: string | null = null
  private ghostX = 0
  private ghostZ = 0
  private ghostValid = true

  /** Set the building placement ghost preview. */
  setGhost(building: string | null, x: number, z: number, valid: boolean): void {
    this.ghostBuilding = building
    this.ghostX = x
    this.ghostZ = z
    this.ghostValid = valid
  }

  private moveIndicators: { x: number; z: number; ttl: number; color: string }[] = []

  /** Show a move-order marker at world position. */
  pingMove(x: number, z: number): void {
    this.moveIndicators.push({ x, z, ttl: 1.0, color: '#4ade80' })
    if (this.moveIndicators.length > 10) this.moveIndicators.shift()
  }

  /** Show an attack-order marker at world position. */
  pingAttack(x: number, z: number): void {
    this.moveIndicators.push({ x, z, ttl: 1.0, color: '#ef4444' })
    if (this.moveIndicators.length > 10) this.moveIndicators.shift()
  }

  render(world: World, team: 0 | 1, dtSeconds = 1 / 60): void {
    this.frame += 1
    this.viewTeam = team
    this.lastDt = dtSeconds
    // Drop flashes for entities that no longer exist (ids can be recycled).
    if (this.hitFlashes.size > 0) {
      for (const id of this.hitFlashes.keys()) {
        if (!world.entities.has(id)) this.hitFlashes.delete(id)
      }
    }
    // Consume visual-only combat events pushed by the sim this frame.
    for (const flash of world.hitFlashes) this.hitFlashes.set(flash.id, 0)
    world.hitFlashes.length = 0
    // Cap: a 100-unit brawl pushes many flashes; oldest fade first.
    while (this.hitFlashes.size > 96) {
      const oldest = this.hitFlashes.keys().next().value
      if (oldest === undefined) break
      this.hitFlashes.delete(oldest)
    }
    // Combat motion (visual-only): age out old lunges, drop motion state
    // for recycled ids, and detect fresh melee/militia strikes from
    // cooldown resets. Direction is toward the strike target when
    // known, else the striker's movement direction; with neither,
    // no lunge. Mustered militia peasants fight as melee (combat.ts)
    // but keep KIND_WORKER, so they need the militia check here —
    // otherwise their strikes silently skip the lunge.
    for (const [id, lunge] of this.lunges) {
      if (!world.entities.has(id)) this.lunges.delete(id)
      else {
        lunge.age += dtSeconds
        if (lunge.age >= LUNGE_DURATION) this.lunges.delete(id)
      }
    }
    for (const id of this.prevCooldown.keys()) {
      if (!world.entities.has(id)) this.prevCooldown.delete(id)
    }
    for (const id of world.entities.keys()) {
      const strikerKind = world.kind[id]
      const isMilitiaStriker = strikerKind === KIND_WORKER && world.isMilitia(id)
      if (strikerKind !== KIND_MELEE && !isMilitiaStriker) continue
      const current = world.cooldown[id]
      const prev = this.prevCooldown.get(id)
      if (strikeJustFired(prev, current)) {
        let ux = 0
        let uz = 0
        const target = world.targetId[id]
        if (target >= 0 && world.entities.has(target)) {
          ux = world.positionX[target] - world.positionX[id]
          uz = world.positionZ[target] - world.positionZ[id]
        }
        if (ux === 0 && uz === 0) {
          ux = world.velocityX[id]
          uz = world.velocityZ[id]
        }
        const len = Math.hypot(ux, uz)
        if (len > 0) {
          this.lunges.set(id, { ux: ux / len, uz: uz / len, age: 0 })
          while (this.lunges.size > 96) {
            const oldest = this.lunges.keys().next().value
            if (oldest === undefined) break
            this.lunges.delete(oldest)
          }
        }
      }
      this.prevCooldown.set(id, current)
    }
    for (const pop of world.deathPops) {
      this.deathPops.push({ ...pop })
      // Fresh pop for the viewing player's own side: one loss sting, throttled.
      if (pop.age === 0 && pop.team === team) this.playLossSfx(pop)
    }
    world.deathPops.length = 0
    // Consume visual-only completion events pushed by the sim this frame.
    // Only the owning team's viewer cues: enemy completions stay silent and
    // invisible (fog already hides them; this keeps ears from leaking intel).
    for (const ev of world.completionFlashes) {
      if (ev.team !== team || !world.entities.has(ev.id)) continue
      this.completionPops.push({
        x: world.positionX[ev.id],
        z: world.positionZ[ev.id],
        age: 0,
        r: world.radius[ev.id],
        unit: ev.unit,
      })
      this.playCompletionSfx(ev.unit)
    }
    world.completionFlashes.length = 0
    // Cap: a queued economy can finish several things at once.
    if (this.completionPops.length > 24) {
      this.completionPops.splice(0, this.completionPops.length - 24)
    }
    // A corrupted camera transform (NaN/Infinity from a bad event or a
    // desync) would paint nothing and misroute every tap. Recover to the
    // default base view instead of leaving the player in a black void.
    if (
      !Number.isFinite(this.camX) ||
      !Number.isFinite(this.camZ) ||
      !Number.isFinite(this.zoom)
    ) {
      this.camX = -40
      this.camZ = -40
      this.zoom = 10
    }
    this.drawGround()
    this.drawSeasonTint(world)
    for (const id of world.entities.keys()) {
      if (!canSee(world, team, id)) continue
      this.drawEntity(world, id)
    }
    // SECOND PASS — held-worker ⏸ markers, after every entity (and every
    // selection ring) has been drawn, so no ring stroke can overpaint any
    // marker. Same visibility rule as the entity loop.
    for (const id of world.entities.keys()) {
      if (!canSee(world, team, id)) continue
      this.drawHeldMarker(world, id)
    }
    this.drawFog(world, team)
    this.drawSelectionBox()
    this.drawDamageNumbers(world, dtSeconds)
    this.drawDeathPops(dtSeconds)
    this.drawCompletionPops(dtSeconds)
    this.drawGhost()
    this.drawRallyPoints(world)
    this.drawMoveIndicators(dtSeconds)
  }

  /**
   * Death pops: expanding ring + fading puff at each kill position.
   * Visual-only (excluded from lockstep hash); ages in real seconds.
   */
  private drawDeathPops(dtSeconds: number): void {
    const { ctx } = this
    const keep: DeathPop[] = []
    for (const pop of this.deathPops) {
      pop.age += dtSeconds
      if (pop.age > 0.4) continue
      keep.push(pop)
      const p = this.toScreen(pop.x, pop.z)
      const q = pop.age / 0.4
      const alpha = 1 - q
      ctx.save()
      ctx.globalAlpha = alpha
      // Fading puff.
      ctx.fillStyle = '#e5e7eb'
      ctx.beginPath()
      ctx.arc(p.x, p.y, pop.r * this.zoom * (0.6 + q * 0.9), 0, Math.PI * 2)
      ctx.fill()
      // Expanding shockwave ring.
      ctx.strokeStyle = '#f5c542'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(p.x, p.y, pop.r * this.zoom * (0.8 + q * 1.6), 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
    this.deathPops = keep
  }

  /**
   * Completion pops: brief gold expanding ring where a building finished or
   * a unit mustered out. Visual-only (excluded from lockstep hash); ages in
   * real seconds. Mirrors the death-pop drawing style for consistency.
   */
  private drawCompletionPops(dtSeconds: number): void {
    const { ctx } = this
    const keep: typeof this.completionPops = []
    for (const pop of this.completionPops) {
      pop.age += dtSeconds
      if (pop.age > 0.6) continue
      keep.push(pop)
      const p = this.toScreen(pop.x, pop.z)
      const q = pop.age / 0.6
      const alpha = 1 - q
      ctx.save()
      ctx.globalAlpha = alpha
      // Gold ring, expanding out from the finished structure/unit.
      ctx.strokeStyle = '#f5c542'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(p.x, p.y, pop.r * this.zoom * (1 + q * 1.4), 0, Math.PI * 2)
      ctx.stroke()
      // Filled dot at the center, shrinking as the ring expands.
      ctx.fillStyle = '#fbbf24'
      ctx.beginPath()
      ctx.arc(p.x, p.y, Math.max(1, 5 * (1 - q)), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    this.completionPops = keep
  }

  /** Throttled loss sting for the player's own deaths (units vs buildings). */
  private playLossSfx(pop: DeathPop): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - this.lastLossSfx < 400) return
    this.lastLossSfx = now
    const isBuilding = isBuildingKind(pop.kind)
    if (isBuilding) sfx.buildingLost()
    else sfx.unitLost()
  }

  /** Completion cue for the player's own side (building or trained unit), throttled. */
  private playCompletionSfx(unit: boolean): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - this.lastCompletionSfx < 300) return
    this.lastCompletionSfx = now
    if (unit) sfx.train()
    else sfx.buildComplete()
  }

  private drawMoveIndicators(dtSeconds: number): void {
    const { ctx } = this
    const keep: typeof this.moveIndicators = []
    for (const m of this.moveIndicators) {
      m.ttl -= dtSeconds
      if (m.ttl <= 0) continue
      keep.push(m)
      const p = this.toScreen(m.x, m.z)
      const alpha = Math.min(1, m.ttl * 2)
      const size = 12 * (1.5 - m.ttl * 0.5) // shrink as it fades
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = m.color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2)
      ctx.stroke()
      // X mark
      ctx.beginPath()
      ctx.moveTo(p.x - 5, p.y - 5)
      ctx.lineTo(p.x + 5, p.y + 5)
      ctx.moveTo(p.x + 5, p.y - 5)
      ctx.lineTo(p.x - 5, p.y + 5)
      ctx.stroke()
      ctx.restore()
    }
    this.moveIndicators = keep
  }

  /** Show rally point lines for selected production buildings. */
  private drawRallyPoints(world: World): void {
    const { ctx } = this
    for (const id of this.selected) {
      const k = world.kind[id]
      // Only production buildings have rally points
      if (k !== 1 && k !== 2 && k !== 3) continue // KIND_HALL, BARRACKS, ARCHERY
      const rx = world.rallyX[id]
      const rz = world.rallyZ[id]
      if (rx === 0 && rz === 0) continue
      const from = this.toScreen(world.positionX[id], world.positionZ[id])
      const to = this.toScreen(rx, rz)
      // Dashed line from building to rally
      ctx.save()
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = '#f5c542'
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.7
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
      // Flag marker at destination
      ctx.setLineDash([])
      ctx.fillStyle = '#f5c542'
      ctx.beginPath()
      ctx.arc(to.x, to.y, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  /** Semi-transparent building placement preview. */
  private drawGhost(): void {
    if (!this.ghostBuilding) return
    const { ctx } = this
    const p = this.toScreen(this.ghostX, this.ghostZ)
    const size = 40 // approx building footprint in px
    ctx.globalAlpha = 0.5
    ctx.fillStyle = this.ghostValid ? '#4ade80' : '#ef4444'
    ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    ctx.globalAlpha = 1
    ctx.strokeStyle = this.ghostValid ? '#22c55e' : '#dc2626'
    ctx.lineWidth = 2
    ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size)
  }

  /** Floating combat text. Visual-only (excluded from lockstep hash); ages in real seconds. */
  private drawDamageNumbers(world: World, dtSeconds: number): void {
    const { ctx } = this
    const keep: typeof world.damageNumbers = []
    for (const dn of world.damageNumbers) {
      dn.age += dtSeconds
      if (dn.age > 0.66) continue
      keep.push(dn)
      const p = this.toScreen(dn.x, dn.z)
      const alpha = 1 - dn.age / 0.66
      const yOff = dn.age * 48 // float upward (~0.8px/frame at 60fps)
      ctx.globalAlpha = alpha
      ctx.font = 'bold 14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      // Enemy damage = red, player damage = white
      ctx.fillStyle = dn.team === 1 ? '#ff6b6b' : '#ffffff'
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 3
      const txt = `-${dn.amount}`
      ctx.strokeText(txt, p.x, p.y - yOff)
      ctx.fillText(txt, p.x, p.y - yOff)
      ctx.globalAlpha = 1
    }
    world.damageNumbers = keep
  }

  private drawSelectionBox(): void {
    const box = this.selectionBox
    if (!box) return
    const { ctx } = this
    const x = Math.min(box.x0, box.x1)
    const y = Math.min(box.y0, box.y1)
    const w = Math.abs(box.x1 - box.x0)
    const h = Math.abs(box.y1 - box.y0)
    ctx.fillStyle = 'rgba(80, 200, 120, 0.12)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(80, 200, 120, 0.8)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x, y, w, h)
  }

  private toScreen(x: number, z: number): { x: number; y: number } {
    return {
      x: (x - this.camX) * this.zoom + this.cssWidth / 2,
      y: (z - this.camZ) * this.zoom + this.cssHeight / 2,
    }
  }

  /**
   * Ground: golden-autumn grass base with deterministic per-cell tint
   * variation across the visible world rect, plus a faint grid for scale.
   * Purely visual — tints are a stable hash of cell coordinates.
   */
  private drawGround(): void {
    const { ctx } = this
    ctx.fillStyle = GROUND_BASE
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight)
    const cell = 10
    const tl = this.screenToWorld(0, 0)
    const br = this.screenToWorld(this.cssWidth, this.cssHeight)
    const x0 = Math.floor(Math.min(tl.x, br.x) / cell)
    const x1 = Math.floor(Math.max(tl.x, br.x) / cell)
    const z0 = Math.floor(Math.min(tl.z, br.z) / cell)
    const z1 = Math.floor(Math.max(tl.z, br.z) / cell)
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const tint = groundTintAt(cx, cz)
        if (tint === GROUND_BASE) continue
        const p = this.toScreen(cx * cell, cz * cell)
        const s = cell * this.zoom + 1 // +1 hides hairline seams between cells
        ctx.fillStyle = tint
        ctx.fillRect(p.x, p.y, s, s)
      }
    }
    // Faint grid for scale reference.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    const step = cell * this.zoom
    const ox = this.cssWidth / 2 - this.camX * this.zoom
    const oy = this.cssHeight / 2 - this.camZ * this.zoom
    ctx.beginPath()
    for (let x = ox % step; x < this.cssWidth; x += step) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, this.cssHeight)
    }
    for (let y = oy % step; y < this.cssHeight; y += step) {
      ctx.moveTo(0, y)
      ctx.lineTo(this.cssWidth, y)
    }
    ctx.stroke()
  }

  /**
   * Season Wheel: once winter turns (Second Bell), a pale snow wash cools
   * the field. Drawn over the ground, under entities and fog, so the world
   * reads colder without hiding anything. Visual-only.
   */
  private drawSeasonTint(world: World): void {
    if (world.season !== 1) return
    const { ctx } = this
    ctx.fillStyle = 'rgba(186, 214, 240, 0.15)'
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight)
  }

  private teamColor(world: World, id: number): string {
    // Neutral creatures (treants) wear bark, not a faction's colors.
    if (world.team[id] > 1) return '#7a5a34'
    const faction = world.factionOfTeam[world.team[id] as 0 | 1]
    return css(FACTIONS[faction].colors[0])
  }

  private drawEntity(world: World, id: number): void {
    const kind = world.kind[id]
    const p = this.toScreen(world.positionX[id], world.positionZ[id])
    const r = Math.max(5, world.radius[id] * this.zoom)
    const color = this.teamColor(world, id)

    if (kind === KIND_TREE) {
      // Kenney CC0 tree sprite; variant picked by a stable position hash so
      // a given tree never flickers between pine and leafy. The old
      // two-circle canopy remains as the not-yet-decoded fallback.
      const leafy = hash2(Math.round(world.positionX[id]), Math.round(world.positionZ[id])) < 0.5
      const sprite = getSprite(leafy ? 'tree_leafy' : 'tree_pine')
      if (sprite) {
        // Subtle shrink as the node depletes (amount is render-visible stock).
        const stock = 0.8 + 0.2 * (world.amount[id] / RESOURCES.wood.amount)
        const size = r * 2.6 * stock
        this.groundShadow(p.x, p.y, r * 0.55)
        this.ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size)
      } else {
        const canopy = treeColorsAt(world.positionX[id], world.positionZ[id])
        this.circle(p.x, p.y, r, canopy.outer)
        this.circle(p.x, p.y, r * 0.55, canopy.inner)
      }
    } else if (kind === KIND_GOLDMINE) {
      // Kenney CC0 rock cluster over a dirt mound (the pack has no dedicated
      // mine sprite — rocks + mound is the honest stand-in). The old gold
      // discs remain as the not-yet-decoded fallback.
      const rocks = getSprite('gold_rocks')
      const mound = getSprite('dirt_mound')
      if (rocks) {
        const stock = 0.8 + 0.2 * (world.amount[id] / RESOURCES.gold.amount)
        this.groundShadow(p.x, p.y, r)
        if (mound) {
          const ms = r * 2.3 * stock
          this.ctx.drawImage(mound, p.x - ms / 2, p.y - ms / 2 + r * 0.22, ms, ms)
        }
        const size = r * 2.1 * stock
        this.ctx.drawImage(rocks, p.x - size / 2, p.y - size / 2, size, size)
      } else {
        this.circle(p.x, p.y, r, '#b8912f')
        this.circle(p.x, p.y, r * 0.55, '#f5c542')
      }
    } else if (kind === KIND_SHRINE) {
      // Shrine of Kings: stone ring, glowing rune colored by holder.
      const held = world.shrineHeld[id]
      const holderFaction = held === 0 || held === 1 ? world.factionOfTeam[held as 0 | 1] : null
      const rune = holderFaction ? css(FACTIONS[holderFaction].colors[0]) : '#f5c542'
      this.circle(p.x, p.y, r, '#4a4a55')
      this.circle(p.x, p.y, r * 0.7, '#2a2a32')
      this.circle(p.x, p.y, r * 0.35, rune)
    } else if (
      (kind >= KIND_HALL && kind <= KIND_FARM) ||
      kind === KIND_WORKSHOP ||
      kind === KIND_SMITHY
    ) {
      // Building: try sprite first, fall back to procedural. (Tower keeps
      // its pre-existing draw path below — unchanged by the tech slice.)
      let spriteKey = SPRITE_FOR_KIND[kind]
      // Farms wear their faction's face: elves grow a grove farm, not a
      // human homestead with fleur-de-lis banners.
      if (kind === KIND_FARM && world.factionOfTeam[world.team[id] as 0 | 1] === 'elf') {
        spriteKey = 'grove_farm'
      }
      const sprite = spriteKey ? getSprite(spriteKey) : null
      this.groundShadow(p.x, p.y, r)
      if (sprite) {
        const size = r * 2.4
        this.ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size)
      } else {
        // Procedural fallback (sprite not decoded yet): thatched-roof
        // silhouette in the sprite set's visual language — timber base,
        // pitched team-colored roof, door notch — not a flat labeled box.
        this.rect(p.x - r, p.y - r * 0.1, r * 2, r * 1.1, '#4a3a28')
        this.ctx.fillStyle = color
        this.ctx.beginPath()
        this.ctx.moveTo(p.x - r * 1.15, p.y - r * 0.1)
        this.ctx.lineTo(p.x, p.y - r * 1.15)
        this.ctx.lineTo(p.x + r * 1.15, p.y - r * 0.1)
        this.ctx.closePath()
        this.ctx.fill()
        this.rect(p.x - r * 0.18, p.y + r * 0.35, r * 0.36, r * 0.65, '#2a2016')
      }
      // Construction progress ring.
      if (world.buildProgress[id] < world.buildTotal[id]) {
        const q = world.buildProgress[id] / world.buildTotal[id]
        this.ctx.strokeStyle = '#f5c542'
        this.ctx.lineWidth = 3
        this.ctx.beginPath()
        this.ctx.arc(p.x, p.y, r + 5, -Math.PI / 2, -Math.PI / 2 + q * Math.PI * 2)
        this.ctx.stroke()
      }
    } else if (kind === KIND_TREANT) {
      // Living Wild guardian: bark-brown trunk, dark canopy crown.
      this.groundShadow(p.x, p.y, r)
      this.circle(p.x, p.y, r, '#4c3620')
      this.circle(p.x, p.y, r * 0.72, '#2e6b3e')
      this.circle(p.x, p.y, r * 0.3, '#5a4028')
    } else {
      // Unit: try sprite first, fall back to procedural discs.
      let spriteKey: string | null = null
      if (kind === KIND_WORKER) spriteKey = 'peasant'
      else if (kind === KIND_MELEE) spriteKey = 'footman'
      else if (kind === KIND_RANGED) spriteKey = 'archer'
      const unitSprite = spriteKey ? getSprite(spriteKey) : null
      // Combat motion, render-only: a lunging striker body shifts toward
      // its target along the strike direction; a just-struck body
      // squashes (wide + short) while its hit flash fades. The ground
      // shadow stays planted at the feet, and overlays below (health
      // bar, flash, rings) stay at the base position. Lunges are only
      // ever recorded for melee/militia strikers, so a map hit here
      // is already the right gate (and it survives a militia expiry
      // mid-swing instead of cutting the 0.18 s animation short).
      let bx = p.x
      let by = p.y
      const lunge = this.lunges.get(id)
      if (lunge) {
        const off = lungeProgress(lunge.age) * r * LUNGE_AMPLITUDE
        bx += lunge.ux * off
        by += lunge.uz * off
      }
      const squash = squashFactors(this.hitFlashes.get(id))
      const squashed = squash.sx !== 1 || squash.sy !== 1
      this.groundShadow(p.x, p.y, r)
      if (squashed) {
        this.ctx.save()
        this.ctx.translate(bx, by)
        this.ctx.scale(squash.sx, squash.sy)
        this.ctx.translate(-bx, -by)
      }
      if (unitSprite) {
        const size = r * 2.2
        this.ctx.drawImage(unitSprite, bx - size / 2, by - size / 2, size, size)
      } else {
        this.circle(bx, by, r, color)
      }
      if (kind === KIND_MELEE) {
        this.ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        this.ctx.lineWidth = 2
        this.ctx.beginPath()
        this.ctx.arc(bx, by, r * 0.7, 0, Math.PI * 2)
        this.ctx.stroke()
      } else if (kind === KIND_RANGED) {
        this.ctx.strokeStyle = '#f5c542'
        this.ctx.lineWidth = 2
        this.ctx.beginPath()
        this.ctx.arc(bx, by, r * 0.7, 0, Math.PI * 2)
        this.ctx.stroke()
      }
      if (squashed) this.ctx.restore()
      // Training progress bar for queued production is drawn on the building.
    }

    // Health bar when damaged.
    if (world.health[id] < world.maxHealth[id] && world.maxHealth[id] > 1) {
      const q = Math.max(0, world.health[id] / world.maxHealth[id])
      const bw = Math.max(18, r * 2)
      this.ctx.fillStyle = 'rgba(0,0,0,0.6)'
      this.ctx.fillRect(p.x - bw / 2, p.y - r - 8, bw, 4)
      this.ctx.fillStyle = q > 0.5 ? '#4ade80' : q > 0.25 ? '#f5c542' : '#ef4444'
      this.ctx.fillRect(p.x - bw / 2, p.y - r - 8, bw * q, 4)
    }

    // Hit flash: white blink on the struck body, fading over ~0.15s.
    // Visual-only; ages in real seconds so it never affects lockstep.
    const flashAge = this.hitFlashes.get(id)
    if (flashAge !== undefined) {
      const fAlpha = Math.max(0, 1 - flashAge / 0.15)
      if (fAlpha <= 0) {
        this.hitFlashes.delete(id)
      } else {
        this.hitFlashes.set(id, flashAge + this.lastDt)
        this.ctx.save()
        this.ctx.globalAlpha = fAlpha * 0.55
        this.ctx.fillStyle = '#ffffff'
        this.ctx.beginPath()
        this.ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        this.ctx.fill()
        this.ctx.restore()
      }
    }

    // Low-HP pulse: the player's own damaged units/buildings get a pulsing
    // red ring so focus-fire is visible at a glance.
    const isUnitOrBuilding =
      kind === KIND_WORKER || kind === KIND_MELEE || kind === KIND_RANGED ||
      isBuildingKind(kind)
    if (
      isUnitOrBuilding &&
      world.team[id] === this.viewTeam &&
      world.health[id] > 0 &&
      world.maxHealth[id] > 1 &&
      world.health[id] < world.maxHealth[id] * 0.3
    ) {
      const pulse = 5 + 2.5 * Math.sin(this.frame / 6)
      this.ctx.save()
      this.ctx.setLineDash([5, 4])
      this.ctx.strokeStyle = 'rgba(239,68,68,0.9)'
      this.ctx.lineWidth = 2
      this.ctx.beginPath()
      this.ctx.arc(p.x, p.y, r + pulse, 0, Math.PI * 2)
      this.ctx.stroke()
      this.ctx.restore()
    }

    // Selection ring.
    if (this.selected.has(id)) {
      this.ctx.strokeStyle = '#ffffff'
      this.ctx.lineWidth = 2
      this.ctx.beginPath()
      this.ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2)
      this.ctx.stroke()
    }

    // Held-worker ⏸ markers are NOT drawn here: they get their own second
    // pass after the entity loop (see render()), because a later-drawn
    // entity's selection-ring stroke overpainted an earlier held worker's
    // marker when the two clustered — only one of two markers survived.
  }

  /**
   * Held-worker marker: a statue (idle + auto-gather disarmed + empty
   * hands) will never re-task itself — without a marker it reads as
   * frozen. Amber ⏸ above the unit, own team only (same precedent as
   * the low-HP pulse: no intel leak about enemy idles). Drawn in its own
   * pass after the entity loop so no selection ring can overpaint it.
   */
  private drawHeldMarker(world: World, id: number): void {
    if (world.team[id] !== this.viewTeam || !isHeldWorker(world, id)) return
    const p = this.toScreen(world.positionX[id], world.positionZ[id])
    const r = Math.max(5, world.radius[id] * this.zoom)
    this.ctx.save()
    this.ctx.font = `bold ${Math.max(11, Math.round(r))}px sans-serif`
    this.ctx.textAlign = 'center'
    this.ctx.textBaseline = 'middle'
    this.ctx.lineWidth = 3
    this.ctx.strokeStyle = 'rgba(0,0,0,0.75)'
    this.ctx.strokeText('⏸', p.x, p.y - r - 18)
    this.ctx.fillStyle = '#f5c542'
    this.ctx.fillText('⏸', p.x, p.y - r - 18)
    this.ctx.restore()
  }

  private drawFog(world: World, team: 0 | 1): void {
    const fog = world.fog[team]
    if (
      !this.fogCache[team] ||
      this.fogCacheRevision[team] !== fog.revision ||
      this.frame - this.fogCacheFrame[team] > 20
    ) {
      this.fogCache[team] = this.buildFogCache(fog)
      this.fogCacheFrame[team] = this.frame
      this.fogCacheRevision[team] = fog.revision
    }
    const cache = this.fogCache[team]
    if (!cache) return
    // Fog grid covers [-90, -90] .. [90, 90] in world units.
    const p = this.toScreen(-90, -90)
    const size = 180 * this.zoom
    this.ctx.drawImage(cache, p.x, p.y, size, size)
    // Beyond the world square there are no fog cells, but the ground pass
    // paints its checkerboard to infinity — so once the camera pans or
    // zooms out past an edge, the screen split into a bright naked-
    // checkerboard zone (outside) versus the fogged world (inside): the
    // "two mismatched maps" players reported. Fill everything outside the
    // square with the same unexplored black the fog uses inside it, so
    // the world edge reads as one uniform darkness at the same single
    // camera transform as everything else.
    const { ctx } = this
    ctx.fillStyle = FOG_UNEXPLORED_FILL
    const w = this.cssWidth
    const h = this.cssHeight
    const x0 = Math.max(0, Math.min(w, p.x))
    const y0 = Math.max(0, Math.min(h, p.y))
    const x1 = Math.max(0, Math.min(w, p.x + size))
    const y1 = Math.max(0, Math.min(h, p.y + size))
    if (y0 > 0) ctx.fillRect(0, 0, w, y0) // above the square
    if (y1 < h) ctx.fillRect(0, y1, w, h - y1) // below the square
    if (x0 > 0 && y1 > y0) ctx.fillRect(0, y0, x0, y1 - y0) // left strip
    if (x1 < w && y1 > y0) ctx.fillRect(x1, y0, w - x1, y1 - y0) // right strip
  }

  private buildFogCache(fog: FogGrid): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = fog.cols
    c.height = fog.cols
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('2D canvas context is unavailable')
    for (let r = 0; r < fog.cols; r += 1) {
      for (let col = 0; col < fog.cols; col += 1) {
        const s = fog.cellState(col, r)
        if (s === FOG_VISIBLE) continue // transparent: fully revealed
        ctx.fillStyle = s === FOG_UNEXPLORED ? FOG_UNEXPLORED_FILL : FOG_EXPLORED_FILL
        ctx.fillRect(col, r, 1, 1)
      }
    }
    return c
  }

  /** Soft contact shadow so sprites sit ON the ground, not float as stickers. */
  private groundShadow(x: number, y: number, r: number): void {
    const { ctx } = this
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.ellipse(x, y + r * 0.72, r * 1.05, r * 0.42, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private circle(x: number, y: number, r: number, fill: string): void {
    this.ctx.fillStyle = fill
    this.ctx.beginPath()
    this.ctx.arc(x, y, r, 0, Math.PI * 2)
    this.ctx.fill()
  }

  private rect(x: number, y: number, w: number, h: number, fill: string): void {
    this.ctx.fillStyle = fill
    this.ctx.fillRect(x, y, w, h)
  }

}
