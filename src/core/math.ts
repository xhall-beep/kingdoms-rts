export const FIXED_POINT_SCALE = 1_000_000

export type FixedPoint = number

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
