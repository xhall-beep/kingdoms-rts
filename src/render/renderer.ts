import { FACTIONS } from '../data/factions.ts'
import type { World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_TREE,
} from '../core/World'
import { FOG_UNEXPLORED, FOG_VISIBLE } from '../world/fog.ts'
import type { FogGrid } from '../world/fog.ts'
import { canSee } from '../world/visibility.ts'

const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

/** Short glyph per entity kind, drawn inside buildings. */
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
  // Fog is cached to an offscreen canvas (one px per cell) and rebuilt only
  // every few frames; per-frame we do a single drawImage instead of ~8k rects.
  private fogCache: (HTMLCanvasElement | null)[] = [null, null]
  private fogCacheFrame: number[] = [-1e9, -1e9]

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context is unavailable')
    this.ctx = ctx
  }

  resize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
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
    const px = cx ?? this.canvas.width / 2
    const py = cy ?? this.canvas.height / 2
    const before = this.screenToWorld(px, py)
    this.zoom = Math.min(40, Math.max(2, this.zoom * factor))
    const after = this.screenToWorld(px, py)
    this.camX += before.x - after.x
    this.camZ += before.z - after.z
  }

  screenToWorld(sx: number, sy: number): { x: number; z: number } {
    return {
      x: (sx - this.canvas.width / 2) / this.zoom + this.camX,
      z: (sy - this.canvas.height / 2) / this.zoom + this.camZ,
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

  render(world: World, team: 0 | 1): void {
    this.frame += 1
    const { ctx, canvas } = this
    ctx.fillStyle = '#16241a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    this.drawGrid()
    for (const id of world.entities.keys()) {
      if (!canSee(world, team, id)) continue
      this.drawEntity(world, id)
    }
    this.drawFog(world, team)
    this.drawSelectionBox()
    this.drawDamageNumbers(world)
    this.drawGhost()
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

  /** Floating combat text. Visual-only; ages and fades. */
  private drawDamageNumbers(world: World): void {
    const { ctx } = this
    const keep: typeof world.damageNumbers = []
    for (const dn of world.damageNumbers) {
      dn.age += 1
      if (dn.age > 40) continue // ~0.66s at 60fps
      keep.push(dn)
      const p = this.toScreen(dn.x, dn.z)
      const alpha = 1 - dn.age / 40
      const yOff = dn.age * 0.8 // float upward
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
      x: (x - this.camX) * this.zoom + this.canvas.width / 2,
      y: (z - this.camZ) * this.zoom + this.canvas.height / 2,
    }
  }

  private drawGrid(): void {
    const { ctx, canvas } = this
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 1
    const step = 10 * this.zoom
    const ox = canvas.width / 2 - this.camX * this.zoom
    const oy = canvas.height / 2 - this.camZ * this.zoom
    ctx.beginPath()
    for (let x = ox % step; x < canvas.width; x += step) {
      ctx.moveTo(x, 0)
      ctx.lineTo(x, canvas.height)
    }
    for (let y = oy % step; y < canvas.height; y += step) {
      ctx.moveTo(0, y)
      ctx.lineTo(canvas.width, y)
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
    } else if (kind >= KIND_HALL && kind <= KIND_FARM) {
      // Building: dark base, team-colored roof, glyph.
      this.rect(p.x - r, p.y - r, r * 2, r * 2, '#3a3f4a')
      this.rect(p.x - r, p.y - r, r * 2, r * 0.7, color)
      const glyph = GLYPH[kind]
      if (glyph && r > 8) {
        this.text(glyph, p.x, p.y + r * 0.55, Math.min(16, r), '#ffffff')
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
      // Unit: team-colored disc, darker ring for melee, gold ring for ranged.
      this.circle(p.x, p.y, r, color)
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
    if (!this.fogCache[team] || this.frame - this.fogCacheFrame[team] > 20) {
      this.fogCache[team] = this.buildFogCache(fog)
      this.fogCacheFrame[team] = this.frame
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
