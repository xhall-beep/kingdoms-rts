import { FACTIONS } from '../data/factions.ts'
import type { World, DeathPop } from '../core/World'
import { sfx } from '../ui/feedback.ts'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_SHRINE,
  KIND_TREE,
  KIND_WORKER,
  KIND_TOWER,
} from '../core/World'
import { FOG_UNEXPLORED, FOG_VISIBLE } from '../world/fog.ts'
import { getSprite } from './sprites.ts'
import type { FogGrid } from '../world/fog.ts'
import { canSee } from '../world/visibility.ts'

const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

/** Short glyph per entity kind, drawn inside buildings. */
/** Sprite key per entity kind (Human faction). Null = procedural. */
const SPRITE_FOR_KIND: Record<number, string | null> = {
  [KIND_HALL]: 'town_hall_l1',
  [KIND_FARM]: 'homestead_farm',
  [KIND_BARRACKS]: 'barracks',
  [KIND_TOWER]: 'guard_tower',
  // KIND_WORKER handled separately (unit rendering below)
}

const GLYPH: Record<number, string> = {
  [KIND_HALL]: 'H',
  [KIND_BARRACKS]: 'B',
  [KIND_ARCHERY]: 'A',
  [KIND_FARM]: 'F',
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
  private zoom = 6
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
  /** Death pops being animated (visual-only, real-time). */
  private deathPops: DeathPop[] = []
  /** Last loss-sfx time (performance.now), throttled so mass deaths stay quiet. */
  private lastLossSfx = 0
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
  }

  pan(dxPixels: number, dyPixels: number): void {
    this.camX -= dxPixels / this.zoom
    this.camZ -= dyPixels / this.zoom
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const px = cx ?? this.cssWidth / 2
    const py = cy ?? this.cssHeight / 2
    const before = this.screenToWorld(px, py)
    this.zoom = Math.min(40, Math.max(2, this.zoom * factor))
    const after = this.screenToWorld(px, py)
    this.camX += before.x - after.x
    this.camZ += before.z - after.z
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
    for (const pop of world.deathPops) {
      this.deathPops.push({ ...pop })
      // Fresh pop for the viewing player's own side: one loss sting, throttled.
      if (pop.age === 0 && pop.team === team) this.playLossSfx(pop)
    }
    world.deathPops.length = 0
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
      this.zoom = 8
    }
    const { ctx } = this
    ctx.fillStyle = '#16241a'
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight)
    this.drawGrid()
    for (const id of world.entities.keys()) {
      if (!canSee(world, team, id)) continue
      this.drawEntity(world, id)
    }
    this.drawFog(world, team)
    this.drawSelectionBox()
    this.drawDamageNumbers(world, dtSeconds)
    this.drawDeathPops(dtSeconds)
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

  /** Throttled loss sting for the player's own deaths (units vs buildings). */
  private playLossSfx(pop: DeathPop): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (now - this.lastLossSfx < 400) return
    this.lastLossSfx = now
    const isBuilding = (pop.kind >= KIND_HALL && pop.kind <= KIND_FARM) || pop.kind === KIND_TOWER
    if (isBuilding) sfx.buildingLost()
    else sfx.unitLost()
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

  private drawGrid(): void {
    const { ctx } = this
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    const step = 10 * this.zoom
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

  private teamColor(world: World, id: number): string {
    const faction = world.factionOfTeam[world.team[id] as 0 | 1]
    return css(FACTIONS[faction].colors[0])
  }

  private drawEntity(world: World, id: number): void {
    const kind = world.kind[id]
    const p = this.toScreen(world.positionX[id], world.positionZ[id])
    const r = Math.max(5, world.radius[id] * this.zoom)
    const color = this.teamColor(world, id)

    if (kind === KIND_TREE) {
      this.circle(p.x, p.y, r, '#2e9e57')
      this.circle(p.x, p.y, r * 0.55, '#3fbf6f')
    } else if (kind === KIND_GOLDMINE) {
      this.circle(p.x, p.y, r, '#b8912f')
      this.circle(p.x, p.y, r * 0.55, '#f5c542')
    } else if (kind === KIND_SHRINE) {
      // Shrine of Kings: stone ring, glowing rune colored by holder.
      const held = world.shrineHeld[id]
      const holderFaction = held === 0 || held === 1 ? world.factionOfTeam[held as 0 | 1] : null
      const rune = holderFaction ? css(FACTIONS[holderFaction].colors[0]) : '#f5c542'
      this.circle(p.x, p.y, r, '#4a4a55')
      this.circle(p.x, p.y, r * 0.7, '#2a2a32')
      this.circle(p.x, p.y, r * 0.35, rune)
    } else if (kind >= KIND_HALL && kind <= KIND_FARM) {
      // Building: try sprite first, fall back to procedural.
      const spriteKey = SPRITE_FOR_KIND[kind]
      const sprite = spriteKey ? getSprite(spriteKey) : null
      if (sprite) {
        const size = r * 2.4
        this.ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size)
      } else {
        // Procedural fallback: dark base, team-colored roof, glyph.
        this.rect(p.x - r, p.y - r, r * 2, r * 2, '#3a3f4a')
        this.rect(p.x - r, p.y - r, r * 2, r * 0.7, color)
        const glyph = GLYPH[kind]
        if (glyph && r > 8) {
          this.text(glyph, p.x, p.y + r * 0.55, Math.min(16, r), '#ffffff')
        }
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
    } else {
      // Unit: try sprite first, fall back to procedural discs.
      let spriteKey: string | null = null
      if (kind === KIND_WORKER) spriteKey = 'peasant'
      else if (kind === KIND_MELEE) spriteKey = 'footman'
      else if (kind === KIND_RANGED) spriteKey = 'archer'
      const unitSprite = spriteKey ? getSprite(spriteKey) : null
      if (unitSprite) {
        const size = r * 2.2
        this.ctx.drawImage(unitSprite, p.x - size / 2, p.y - size / 2, size, size)
      } else {
        this.circle(p.x, p.y, r, color)
      }
      if (kind === KIND_MELEE) {
        this.ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        this.ctx.lineWidth = 2
        this.ctx.beginPath()
        this.ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2)
        this.ctx.stroke()
      } else if (kind === KIND_RANGED) {
        this.ctx.strokeStyle = '#f5c542'
        this.ctx.lineWidth = 2
        this.ctx.beginPath()
        this.ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2)
        this.ctx.stroke()
      }
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
      (kind >= KIND_HALL && kind <= KIND_FARM) || kind === KIND_TOWER
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
        ctx.fillStyle = s === FOG_UNEXPLORED ? '#040806' : 'rgba(4,8,6,0.45)'
        ctx.fillRect(col, r, 1, 1)
      }
    }
    return c
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

  private text(s: string, x: number, y: number, size: number, fill: string): void {
    this.ctx.fillStyle = fill
    this.ctx.font = `700 ${size}px system-ui, sans-serif`
    this.ctx.textAlign = 'center'
    this.ctx.fillText(s, x, y)
  }
}
