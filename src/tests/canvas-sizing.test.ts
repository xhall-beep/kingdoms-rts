/**
 * Canvas sizing regression tests.
 *
 * Background: on the Pixel 11 Pro the live game rendered a black map and
 * every map tap misrouted, while the sim and DOM HUD worked. Root cause: the
 * renderer sized its canvas backing store ONCE from `canvas.clientWidth`
 * with a hardcoded 1280x720 fallback and never re-measured. When the
 * measurement missed (or the viewport later changed), backing pixels
 * diverged from CSS pixels: the renderer's world<->screen math used the
 * wrong dimensions, so the revealed fog area shrank to a dot and taps mapped
 * tens of world units off. The renderer now works purely in CSS pixels
 * (backing = css * dpr, context scaled), re-measures on viewport changes,
 * and recovers from a NaN/Infinity camera transform instead of painting
 * nothing.
 */
import { Renderer } from '../render/renderer.ts'
import { FogGrid } from '../world/fog.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

interface FakeCtx {
  fillStyle: string
  strokeStyle: string
  globalAlpha: number
  lineWidth: number
  font: string
  textAlign: string
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fill(): void
  arc(x: number, y: number, r: number, a0: number, a1: number): void
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void
  save(): void
  restore(): void
  setLineDash(d: number[]): void
  fillText(s: string, x: number, y: number): void
  strokeText(s: string, x: number, y: number): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
}

function makeFakeCtx(): FakeCtx {
  return {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: '',
    fillRect(): void {},
    strokeRect(): void {},
    beginPath(): void {},
    moveTo(): void {},
    lineTo(): void {},
    stroke(): void {},
    fill(): void {},
    arc(): void {},
    drawImage(): void {},
    save(): void {},
    restore(): void {},
    setLineDash(): void {},
    fillText(): void {},
    strokeText(): void {},
    setTransform(): void {},
  }
}

function makeRenderer(): { renderer: Renderer; canvas: { width: number; height: number } } {
  const ctx = makeFakeCtx()
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
  }
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement)
  return { renderer, canvas }
}

/** Minimal world shape sufficient for Renderer.render with no entities. */
function emptyWorld(): unknown {
  return {
    entities: new Map<number, number>(),
    fog: [new FogGrid(), new FogGrid()],
    damageNumbers: [],
  }
}

/** Stub document.createElement('canvas') for the fog-cache offscreen build. */
function stubDocument(): () => void {
  const prev = (globalThis as Record<string, unknown>)['document']
  ;(globalThis as Record<string, unknown>)['document'] = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
      const ctx = makeFakeCtx()
      return { width: 0, height: 0, getContext: () => ctx }
    },
  }
  return () => {
    if (prev === undefined) delete (globalThis as Record<string, unknown>)['document']
    else (globalThis as Record<string, unknown>)['document'] = prev
  }
}

suite('Renderer canvas sizing')

test('resize stores CSS size and scales backing by DPR', () => {
  const { renderer, canvas } = makeRenderer()
  // Node has no window: dpr falls back to 1.
  renderer.resize(412, 800)
  assertEqual(canvas.width, 412, 'backing width = css width at dpr 1')
  assertEqual(canvas.height, 800, 'backing height = css height at dpr 1')
  assertEqual(renderer.getCssSize().w, 412, 'css width stored')
  assertEqual(renderer.getCssSize().h, 800, 'css height stored')
})

test('resize honors devicePixelRatio when present', () => {
  const prev = (globalThis as Record<string, unknown>)['window']
  ;(globalThis as Record<string, unknown>)['window'] = { devicePixelRatio: 2 }
  try {
    const { renderer, canvas } = makeRenderer()
    renderer.resize(412, 800)
    assertEqual(canvas.width, 824, 'backing width = css * dpr')
    assertEqual(canvas.height, 1600, 'backing height = css * dpr')
    // Coordinate math stays in CSS pixels regardless of backing scale.
    renderer.centerOn(-40, -40, 8)
    const w = renderer.screenToWorld(206, 400)
    assertEqual(Math.round(w.x), -40, 'tap x maps to base at dpr 2')
    assertEqual(Math.round(w.z), -40, 'tap z maps to base at dpr 2')
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>)['window']
    else (globalThis as Record<string, unknown>)['window'] = prev
  }
})

test('tap at CSS center maps to camera target (Pixel bug scenario)', () => {
  // Reproduces the field failure: CSS viewport 412x800 (Pixel-ish), camera
  // on the base at (-40,-40) zoom 8. A tap dead-center must hit the base.
  const { renderer } = makeRenderer()
  renderer.resize(412, 800)
  renderer.centerOn(-40, -40, 8)
  const w = renderer.screenToWorld(206, 400)
  assert(Math.abs(w.x - -40) < 0.001, `tap x near -40, got ${w.x}`)
  assert(Math.abs(w.z - -40) < 0.001, `tap z near -40, got ${w.z}`)
})

test('sight-10 reveal radius is a usable size on a phone viewport', () => {
  // The visible symptom was a dot-sized revealed patch. With correct CSS-px
  // math, sight 10 at zoom 8 spans 80 CSS px — a real playable area.
  const { renderer } = makeRenderer()
  renderer.resize(412, 800)
  renderer.centerOn(-40, -40, 8)
  const a = renderer.screenToWorld(206, 400)
  const b = renderer.screenToWorld(286, 400)
  const worldPer80px = b.x - a.x
  // 80 CSS px at zoom 8 = 10 world units.
  assert(Math.abs(worldPer80px - 10) < 0.001, `80px = 10 world units, got ${worldPer80px}`)
})

test('NaN camera transform recovers instead of painting black', () => {
  const restore = stubDocument()
  try {
    const { renderer } = makeRenderer()
    renderer.resize(412, 800)
    renderer.centerOn(-40, -40, 8)
    // Corrupt the camera the way a bad event could.
    ;(renderer as unknown as { camX: number }).camX = NaN
    const before = renderer.screenToWorld(206, 400)
    assert(!Number.isFinite(before.x), 'sanity: NaN camera breaks mapping')
    renderer.render(emptyWorld() as never, 0)
    const after = renderer.screenToWorld(206, 400)
    assert(Number.isFinite(after.x) && Number.isFinite(after.z), 'mapping finite after render')
    assert(Math.abs(after.x - -40) < 0.001, `camera recovered to base x, got ${after.x}`)
    assert(Math.abs(after.z - -40) < 0.001, `camera recovered to base z, got ${after.z}`)
  } finally {
    restore()
  }
})

test('Infinity zoom recovers', () => {
  const restore = stubDocument()
  try {
    const { renderer } = makeRenderer()
    renderer.resize(412, 800)
    ;(renderer as unknown as { zoom: number }).zoom = Infinity
    renderer.render(emptyWorld() as never, 0)
    const w = renderer.screenToWorld(206, 400)
    assert(Number.isFinite(w.x) && Number.isFinite(w.z), 'mapping finite after recovery')
  } finally {
    restore()
  }
})

test('resize clamps degenerate dimensions', () => {
  const { renderer, canvas } = makeRenderer()
  renderer.resize(0, -5)
  assert(canvas.width >= 1 && canvas.height >= 1, 'backing never zero')
  assertEqual(renderer.getCssSize().w, 1, 'css width clamped')
})
