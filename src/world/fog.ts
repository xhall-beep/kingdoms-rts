/**
 * Fog of war for one team, stored as a flat byte array (one byte per cell).
 *   UNEXPLORED: never seen.  EXPLORED: seen before, not visible now.  VISIBLE: seen right now.
 * Demotion only touches cells that were visible last update, so cost scales with
 * what units see, not with map size.
 */
export const FOG_UNEXPLORED = 0
export const FOG_EXPLORED = 1
export const FOG_VISIBLE = 2

export class FogGrid {
  readonly cell: number
  readonly cols: number
  private readonly half: number
  private readonly cells: Uint8Array
  private visibleNow: number[] = [] // Indices currently VISIBLE; demoted at the next beginUpdate.
  /**
   * Monotonic counter bumped when the rendered fog content changes, i.e. when
   * the set of VISIBLE cells differs from the previous vision update. Lets the
   * renderer rebuild its cached fog bitmap exactly when needed instead of on
   * a fixed frame cadence, so a cache built before the first vision update
   * can never linger as a stale black screen. Derived from deterministic sim
   * ops only; not part of the lockstep hash (cells + visibleNow already are).
   */
  revision = 0
  /** VISIBLE indices at the end of the previous vision update (a set; order is irrelevant — endUpdate compares membership, not sequence). */
  private lastVisible: number[] = []
  /**
   * Scratch membership marks for endUpdate's set comparison: one slot per
   * cell, holding the generation of the last update that stamped it. Lets
   * endUpdate test exact set equality in O(visible) instead of sorting.
   * Internal scratch only — never serialized, never hashed.
   */
  private readonly visibleStamp: Int32Array
  private stampGen = 0

  constructor(size = 180, cell = 2) {
    this.cell = cell
    this.cols = Math.ceil(size / cell)
    this.half = size / 2
    this.cells = new Uint8Array(this.cols * this.cols) // All UNEXPLORED (0).
    this.visibleStamp = new Int32Array(this.cols * this.cols)
  }

  private toCell(v: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((v + this.half) / this.cell)))
  }

  stateAt(x: number, z: number): number {
    return this.cells[this.toCell(z) * this.cols + this.toCell(x)]
  }

  /** Direct cell read (0 = unexplored, 1 = explored, 2 = visible). */
  cellState(col: number, row: number): number {
    return this.cells[row * this.cols + col]
  }

  /** Full cell array copy for save files. */
  snapshotCells(): number[] {
    return Array.from(this.cells)
  }

  /** Restore cell states from a save file. */
  restoreCells(data: number[]): void {
    const n = Math.min(data.length, this.cells.length)
    for (let i = 0; i < n; i += 1) this.cells[i] = data[i]
    // Content may have changed behind the renderer's back: force a rebuild
    // and re-sync the visible-set baseline on the next endUpdate().
    this.revision += 1
    this.lastVisible = []
  }

  /** Call once per vision update, before any reveal(): last update's visible cells become EXPLORED. */
  beginUpdate(): void {
    for (const i of this.visibleNow) this.cells[i] = FOG_EXPLORED
    this.visibleNow.length = 0
  }

  /** Mark every cell whose centre lies within `radius` of (x, z) as VISIBLE. */
  reveal(x: number, z: number, radius: number): void {
    const c0 = this.toCell(x - radius)
    const c1 = this.toCell(x + radius)
    const r0 = this.toCell(z - radius)
    const r1 = this.toCell(z + radius)
    const rSq = radius * radius
    for (let r = r0; r <= r1; r += 1) {
      const dz = r * this.cell - this.half + this.cell / 2 - z
      for (let c = c0; c <= c1; c += 1) {
        const dx = c * this.cell - this.half + this.cell / 2 - x
        if (dx * dx + dz * dz > rSq) continue
        const i = r * this.cols + c
        if (this.cells[i] !== FOG_VISIBLE) {
          this.cells[i] = FOG_VISIBLE
          this.visibleNow.push(i)
        }
      }
    }
  }

  /**
   * Call once per vision update, after all reveal() calls. Bumps `revision`
   * only when the VISIBLE set actually changed since the previous update —
   * a stationary scene demotes and re-reveals the same cells every step, and
   * that must NOT invalidate the renderer's cache.
   *
   * The change test is exact set equality in O(visible): stamp every
   * currently visible index with this call's generation, then confirm the
   * previous set is fully covered. Equal length + full coverage means the
   * sets are identical. (The previous implementation sorted both sets and
   * compared element-wise — same semantics, O(n log n) with a comparator,
   * ~0.9 ms per call at ~2,200 visible cells.)
   */
  endUpdate(): void {
    let changed = this.visibleNow.length !== this.lastVisible.length
    if (!changed) {
      this.stampGen += 1
      if (this.stampGen >= 0x7fffffff) {
        // Generation exhausted (centuries of updates away): reset the
        // scratch marks so a stale stamp can never alias the live one.
        this.visibleStamp.fill(0)
        this.stampGen = 1
      }
      const gen = this.stampGen
      for (const i of this.visibleNow) this.visibleStamp[i] = gen
      for (const i of this.lastVisible) {
        if (this.visibleStamp[i] !== gen) {
          changed = true
          break
        }
      }
    }
    if (changed) {
      this.revision += 1
      this.lastVisible = [...this.visibleNow]
    }
  }

  /**
   * Pending demotions (cells VISIBLE this update, demoted next beginUpdate).
   * Part of deterministic sim state: must be snapshotted and hashed for
   * lockstep, otherwise peers diverge on the next vision update.
   */
  snapshotVisibleNow(): number[] {
    return [...this.visibleNow]
  }

  restoreVisibleNow(indices: number[]): void {
    this.visibleNow = [...indices]
    this.revision += 1
    this.lastVisible = []
  }
}
