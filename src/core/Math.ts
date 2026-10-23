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

/**
 * Precomputed unit-circle offsets for the AI build-placement ring
 * (src/ai/opponent.ts): candidate k (0..29) sits at angle
 * (k % 10) * 0.628 + floor(k / 10) * 0.3 — 10 slots per ring, 3 rings.
 *
 * Math.cos/Math.sin are implementation-approximated in ECMAScript, so two
 * engines (two phones) can return different last bits for the same angle and
 * silently desync the lockstep hash. These literals are the exact doubles
 * those angle expressions produce; decimal literals parse to the identical
 * double on every conforming engine, so placement is bit-stable everywhere.
 * Do not regenerate with a "cleaner" angle formula (e.g. 2π/10) — the slot
 * positions are load-bearing and pinned by tests.
 */
export const BUILD_RING_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.8092041809880323, 0.5875275257138919],
  [0.3096228130570242, 0.95085946050647],
  [-0.30810803127799236, 0.9513513762338286],
  [-0.80826742726931, 0.5888155619677953],
  [-0.9999987317275395, 0.0015926529164868282],
  [-0.8101388821239993, -0.5862379991700271],
  [-0.3111368094638822, -0.9503651328813763],
  [0.3065924679690989, -0.9518408788156858],
  [0.8073286233439505, -0.5901021046645756],
  [0.955336489125606, 0.29552020666133955],
  [0.5994360254326735, 0.800422670476967],
  [0.01479578690432947, 0.9998905363537959],
  [-0.5754904001846903, 0.8178085346187487],
  [-0.9461742628001844, 0.32365763456857866],
  [-0.9558059386176664, -0.2939983124155676],
  [-0.6007100606850283, -0.7994669617887844],
  [-0.016388246718132306, -0.9998657036670003],
  [0.5741871851582762, -0.8187240538789706],
  [0.9456575885177853, -0.3251641512816676],
  [0.8253356149096783, 0.5646424733950354],
  [0.3361220349964831, 0.9418184419461232],
  [-0.2813529028269585, 0.9596043685138391],
  [-0.7914659255978721, 0.6112132922454351],
  [-0.9995621693797634, 0.02958833460709293],
  [-0.8262338476412722, -0.56332728410037],
  [-0.33762159859053, -0.9412819217243976],
  [0.2798242292986327, -0.9600512489952951],
  [0.7904914711709448, -0.6124730475751528],
  [0.9995137777151855, -0.03118025268529602],
]

/**
 * Cardinal unit-circle offsets (angles 0, π/2, π, 3π/2) for the tower-defense
 * starting-worker ring (src/modes/tower-defense.ts). Same determinism
 * rationale as BUILD_RING_OFFSETS: literal doubles instead of runtime trig.
 * The ~1e-16 components are the exact values cos/sin return at those angles
 * (π/2 is not exactly representable) — preserved so spawns are bit-identical.
 */
export const CARDINAL_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [6.123233995736766e-17, 1],
  [-1, 1.2246467991473532e-16],
  [-1.8369701987210297e-16, -1],
]

export const lerp = (from: number, to: number, amount: number): number =>
  from + (to - from) * clamp(amount, 0, 1)
