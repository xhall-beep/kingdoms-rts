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

  constructor(size = 180, cell = 2) {
    this.cell = cell
    this.cols = Math.ceil(size / cell)
    this.half = size / 2
    this.cells = new Uint8Array(this.cols * this.cols) // All UNEXPLORED (0).
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
   * Pending demotions (cells VISIBLE this update, demoted next beginUpdate).
   * Part of deterministic sim state: must be snapshotted and hashed for
   * lockstep, otherwise peers diverge on the next vision update.
   */
  snapshotVisibleNow(): number[] {
    return [...this.visibleNow]
  }

  restoreVisibleNow(indices: number[]): void {
    this.visibleNow = [...indices]
  }
}
