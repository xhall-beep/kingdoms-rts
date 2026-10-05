export const FIXED_POINT_SCALE = 1_000_000

export type FixedPoint = number

export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = Math.trunc(seed) >>> 0 || 0x6d2b79f5
  }

  next(): number {
    let value = this.state + 0x6d2b79f5
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    this.state = value ^ (value >>> 14)
    return (this.state >>> 0) / 0x100000000
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next()
  }

  integer(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }
}

export const toFixedPoint = (value: number): FixedPoint =>
  Math.round(value * FIXED_POINT_SCALE)

export const fromFixedPoint = (value: FixedPoint): number =>
  value / FIXED_POINT_SCALE

export const addFixedPoint = (left: FixedPoint, right: FixedPoint): FixedPoint =>
  left + right

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

export const lerp = (from: number, to: number, amount: number): number =>
  from + (to - from) * clamp(amount, 0, 1)
