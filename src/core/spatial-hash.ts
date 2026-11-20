/**
 * Spatial hash grid for O(1)-ish neighbor queries.
 *
 * Determinism: entities are inserted in world iteration order and each gets
 * a sequence number. Queries yield (id, seq) pairs; callers break distance
 * ties by lower sequence number, which reproduces the exact target selection
 * of a full linear scan. This keeps lockstep PvP in sync.
 *
 * Cell keys are packed integers (mixed radix), not strings: the grid is
 * rebuilt every tick and queried by every combat/gather/movement search, so
 * per-call string construction + string hashing was measured as the largest
 * fixed per-tick cost in the engine (rebuild 70.7 µs at 195 entities,
 * 2026-11-20 micro-benchmark). The packing is exact while cell coordinates
 * stay within ±2^25 (≈ ±800M world units at cellSize 24) — far beyond any
 * position the game can produce (the playfield is ±90 and positions are
 * Float32). Contents, visit order and sequence numbers are unchanged from
 * the string-keyed version, so query results are bit-identical.
 */

export class SpatialHash {
  private readonly cellSize: number
  private readonly cells = new Map<number, number[]>()
  /** Entity ID -> insertion sequence (world iteration order); -1 = not in the current rebuild. */
  private seqArr = new Int32Array(0)

  constructor(cellSize = 24) {
    this.cellSize = cellSize
  }

  private key(cx: number, cz: number): number {
    // Mixed radix: exact while |cz| < 2^26 and |cx| < 2^25 (see header).
    return cx * 67108864 + cz
  }

  /** Rebuild from scratch. `ids` must be in deterministic (world) order. */
  rebuild(entries: Iterable<{ id: number; x: number; z: number }>): void {
    this.cells.clear()
    // Every slot starts at the not-inserted sentinel, so sequenceOf keeps
    // its old semantics for ids absent from this rebuild (recycled ids,
    // mid-tick spawns) without a Map.
    this.seqArr.fill(-1)
    let n = 0
    for (const e of entries) {
      if (e.id >= this.seqArr.length) {
        let len = Math.max(64, this.seqArr.length * 2)
        while (len <= e.id) len *= 2
        const next = new Int32Array(len)
        next.set(this.seqArr)
        next.fill(-1, this.seqArr.length)
        this.seqArr = next
      }
      const cx = Math.floor(e.x / this.cellSize)
      const cz = Math.floor(e.z / this.cellSize)
      const k = this.key(cx, cz)
      let cell = this.cells.get(k)
      if (!cell) {
        cell = []
        this.cells.set(k, cell)
      }
      cell.push(e.id)
      this.seqArr[e.id] = n++
    }
  }

  /** Sequence number for tie-breaking (lower = earlier in world order). */
  sequenceOf(id: number): number {
    if (id < 0 || id >= this.seqArr.length) return Number.MAX_SAFE_INTEGER
    const s = this.seqArr[id]
    return s < 0 ? Number.MAX_SAFE_INTEGER : s
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
