/**
 * Combat-motion helpers — pure functions for render-only game feel.
 *
 * Attack lunge (the striker leans into the blow) and squash-on-hit (the
 * struck body squashes for a beat) are visual-only: they read sim state
 * the renderer already sees, keep all state on the renderer, and never
 * feed the sim or the lockstep hash. Keeping the math here, headless
 * and pure, lets tests pin the envelopes without a canvas.
 */

/** Lunge animation length in real seconds (~11 frames at 60 fps). */
export const LUNGE_DURATION = 0.18
/** Lunge travel as a fraction of the unit's screen radius. */
export const LUNGE_AMPLITUDE = 0.55

/** Squash animation length — matches the hit-flash fade (~0.15 s). */
export const SQUASH_DURATION = 0.15
/** Squash depth as a fraction of the body size at the moment of impact. */
export const SQUASH_AMOUNT = 0.18

/**
 * Strike detector: a melee cooldown jumping UP between renders means the
 * sim just reset it on a strike (cooldowns only ever count down inside
 * the sim). No previous reading yet means "unknown", never a strike.
 */
export function strikeJustFired(prev: number | undefined, current: number): boolean {
  return prev !== undefined && current > prev
}

/**
 * Lunge envelope: 0 at rest, 1 at mid-swing, back to 0 at the end.
 * Ages outside [0, LUNGE_DURATION] read as rest.
 */
export function lungeProgress(ageSeconds: number): number {
  if (ageSeconds <= 0 || ageSeconds >= LUNGE_DURATION) return 0
  return Math.sin((Math.PI * ageSeconds) / LUNGE_DURATION)
}

/**
 * Squash factors for a body struck `flashAgeSeconds` ago: wide and short
 * at impact, easing back to (1, 1) as the hit flash fades. No flash (or
 * an expired one) reads as unscaled.
 */
export function squashFactors(flashAgeSeconds: number | undefined): { sx: number; sy: number } {
  if (flashAgeSeconds === undefined || flashAgeSeconds >= SQUASH_DURATION) {
    return { sx: 1, sy: 1 }
  }
  const q = 1 - flashAgeSeconds / SQUASH_DURATION
  return { sx: 1 + SQUASH_AMOUNT * q, sy: 1 - SQUASH_AMOUNT * q }
}
