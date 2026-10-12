/**
 * Spatial hash grid for O(1)-ish neighbor queries.
 *
 * Determinism: entities are inserted in world iteration order and each gets
 * a sequence number. Queries yield (id, seq) pairs; callers break distance
 * ties by lower sequence number, which reproduces the exact target selection
 * of a full linear scan. This keeps lockstep PvP in sync.
 */

export class SpatialHash {
  private readonly cellSize: number
  private readonly cells = new Map<string, number[]>()
  /** Entity ID -> insertion sequence (world iteration order). */
  private readonly seq = new Map<number, number>()

  constructor(cellSize = 24) {
    this.cellSize = cellSize
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`
  }

  /** Rebuild from scratch. `ids` must be in deterministic (world) order. */
  rebuild(entries: Iterable<{ id: number; x: number; z: number }>): void {
    this.cells.clear()
    this.seq.clear()
    let n = 0
    for (const e of entries) {
      const cx = Math.floor(e.x / this.cellSize)
      const cz = Math.floor(e.z / this.cellSize)
      const k = this.key(cx, cz)
      let cell = this.cells.get(k)
      if (!cell) {
        cell = []
        this.cells.set(k, cell)
      }
      cell.push(e.id)
      this.seq.set(e.id, n++)
    }
  }

  /** Sequence number for tie-breaking (lower = earlier in world order). */
  sequenceOf(id: number): number {
    return this.seq.get(id) ?? Number.MAX_SAFE_INTEGER
  }

  /**
   * Call `cb` for every entity in the 3x3 cells around (x, z).
   * With cellSize >= max query radius, this covers the full circle.
   */
  forEachNear(x: number, z: number, cb: (id: number) => void): void {
    const cx = Math.floor(x / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.cells.get(this.key(cx + dx, cz + dz))
        if (!cell) continue
        for (const id of cell) cb(id)
      }
    }
  }

  /** Call `cb` for every entity in cells overlapping the world rect. */
  forEachInRect(x0: number, z0: number, x1: number, z1: number, cb: (id: number) => void): void {
    const cx0 = Math.floor(Math.min(x0, x1) / this.cellSize)
    const cx1 = Math.floor(Math.max(x0, x1) / this.cellSize)
    const cz0 = Math.floor(Math.min(z0, z1) / this.cellSize)
    const cz1 = Math.floor(Math.max(z0, z1) / this.cellSize)
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(this.key(cx, cz))
        if (!cell) continue
        for (const id of cell) cb(id)
      }
    }
  }
}
