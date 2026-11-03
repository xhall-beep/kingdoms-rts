/**
 * Basics slice 7 — "Workers stop being 7-pixel figures"
 * (Montz's "Improve basics", 2026-11-03; basics audit F4, remaining half).
 *
 * The audit measured the peasant's solid figure at 7.0px wide at
 * zoom 10. The shipped boot zoom is 13, which lifts it to ~9.1px —
 * still the smallest readable element on a phone screen — and the
 * audit's own fix fork (boot zoom 13) is therefore already spent.
 * What is pinned here is the fork's second half, a draw-scale floor:
 *  - A unit sprite box is r * 2.2, floored at 19 CSS px, so a worker
 *    (radius 0.5) draws a 19px box at boot zoom instead of 14.3px —
 *    a ~12.1px solid figure (163/256 of the box), still inside the
 *    21px selection-ring diameter.
 *  - Combat units are untouched: a melee unit (radius 0.9) draws
 *    25.7px at boot zoom, above the floor, exactly as before.
 *  - The floor only bites at small draw radii (small units, low
 *    zoom); at high zoom the 2.2x scale wins again.
 *  - Render-only: world radius, tap picking (40px tolerance in the
 *    input controller), and sim state are unchanged by construction
 *    — the helper lives in the renderer and nothing in it is hashed.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  UNIT_SPRITE_MIN_SIZE_PX,
  unitSpriteSize,
} from '../render/renderer.ts'

// Draw radius r = max(5, worldRadius * zoom); boot zoom is 13.
const workerAtBoot = 0.5 * 13 // 6.5
const meleeAtBoot = 0.9 * 13 // 11.7

suite('Basics slice 7 — unit sprite minimum size (audit F4)')

test('floor constant is 19px', () => {
  assertEqual(UNIT_SPRITE_MIN_SIZE_PX, 19, 'floor constant')
})

test('worker at boot zoom draws the floored 19px box, not 14.3px', () => {
  assertEqual(unitSpriteSize(workerAtBoot), 19, 'worker box at boot zoom')
  assert(unitSpriteSize(workerAtBoot) > workerAtBoot * 2.2, 'floored box larger than old 14.3px')
})

test('floored box holds a solid figure at least 12px wide', () => {
  // Audit alpha bbox: solid width is 163/256 of the sprite box.
  const solid = unitSpriteSize(workerAtBoot) * (163 / 256)
  assert(solid >= 12, `solid figure ${solid}px wide, want >= 12px`)
})

test('floored box stays inside the boot-zoom selection ring', () => {
  const ringDiameter = 2 * (workerAtBoot + 4) // selection ring is r + 4
  assert(unitSpriteSize(workerAtBoot) < ringDiameter, 'floored box inside selection ring')
})

test('melee at boot zoom is unchanged (above the floor)', () => {
  assertEqual(unitSpriteSize(meleeAtBoot), meleeAtBoot * 2.2, 'melee box unchanged')
})

test('floor bites for small radii at low zoom', () => {
  // Zoomed-out worker: draw radius clamps at 5, old box 11px.
  assertEqual(unitSpriteSize(5), 19, 'zoomed-out worker floored')
})

test('scale wins again at high zoom', () => {
  // Zoom 20 worker: r = 10, box 22px.
  assertEqual(unitSpriteSize(10), 22, 'zoomed-in worker scales')
})

test('size grows monotonically with draw radius', () => {
  const radii = [5, 6.5, 8, 8.64, 11.7, 20]
  let prev = 0
  for (const r of radii) {
    const size = unitSpriteSize(r)
    assert(size >= prev, `size at r=${r} regressed`)
    prev = size
  }
})
