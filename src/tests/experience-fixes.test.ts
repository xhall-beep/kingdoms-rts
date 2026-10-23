/**
 * Regression tests for the 2026-10-22 experience fixes (the build Montz
 * rejected on sight: undismissable tutorial, split map, no pinch zoom,
 * HUD overlap, unidentified builds).
 *
 * Defect #1 root cause, for the record: the deploy pipeline inlined only
 * the JS bundle into index.html and silently discarded esbuild's CSS
 * output, so the shipped page ran a stale stylesheet whose .hud-tutorial
 * rule had no pointer-events opt-in (its parent #hud-root is
 * pointer-events:none) and no position:fixed — the card was untappable
 * and half off-screen. These tests therefore cover BEHAVIOUR (mount the
 * real HUD against a fake DOM and click things) plus the pipeline guard
 * (the deploy script must inline the CSS and the build stamp), not just
 * source strings.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import { HudImpl } from '../ui/hud.ts'
import { InputControllerImpl, pinchStep } from '../input/input-controller.ts'
import { Renderer, FOG_UNEXPLORED_FILL } from '../render/renderer.ts'
import { World } from '../core/World.ts'
import { makeWorld } from './setup.ts'
import { BUILD_STAMP, BUILD_STAMP_LABEL } from '../build-stamp.ts'

// ---------------------------------------------------------------------------
// File access (same resolution pattern as experience.test.ts)
// ---------------------------------------------------------------------------

function readRepoFile(rel: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    `${here}../../${rel}`, // src/tests -> repo root
    `${here}../../../${rel}`,
    `/home/hatch/workspace/kingdoms-rts/${rel}`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  throw new Error(`cannot locate ${rel}`)
}

function readDeployScript(): string | null {
  const candidates = [
    '/home/hatch/workspace/bin/kingdoms-deploy-all.py',
    fileURLToPath(new URL('../../../bin/kingdoms-deploy-all.py', import.meta.url)),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  return null
}

// ---------------------------------------------------------------------------
// Fake DOM for HudImpl.mount
// ---------------------------------------------------------------------------

class FakeEl {
  hidden = false
  textContent = ''
  value = ''
  className = ''
  dataset: Record<string, string> = {}
  style: Record<string, unknown> = {}
  children: FakeEl[] = []
  private classes = new Set<string>()
  private listeners = new Map<string, Array<() => void>>()
  private bySelector = new Map<string, FakeEl>()
  classList = {
    add: (...cs: string[]): void => {
      for (const c of cs) this.classes.add(c)
    },
    remove: (...cs: string[]): void => {
      for (const c of cs) this.classes.delete(c)
    },
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string): void => {
      if (this.classes.has(c)) this.classes.delete(c)
      else this.classes.add(c)
    },
  }

  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn()
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child)
    return child
  }

  querySelector(sel: string): FakeEl {
    let el = this.bySelector.get(sel)
    if (!el) {
      el = new FakeEl()
      this.bySelector.set(sel, el)
    }
    return el
  }

  querySelectorAll(_sel: string): FakeEl[] {
    return []
  }

  setAttribute(_k: string, _v: string): void {}
  getAttribute(_k: string): string | null {
    return null
  }

  /** Test helper: pre-create a child that starts hidden (template `hidden` attr). */
  primeHidden(sel: string): void {
    this.querySelector(sel).hidden = true
  }
}

function stubLocalStorage(): () => void {
  const g = globalThis as Record<string, unknown>
  const prev = g['localStorage']
  const map = new Map<string, string>()
  g['localStorage'] = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
  }
  return () => {
    if (prev === undefined) delete g['localStorage']
    else g['localStorage'] = prev
  }
}

function stubDocument(): () => void {
  const g = globalThis as Record<string, unknown>
  const prev = g['document']
  g['document'] = {
    createElement: () => new FakeEl(),
    querySelector: () => null,
    getElementById: () => null,
    body: new FakeEl(),
  }
  return () => {
    if (prev === undefined) delete g['document']
    else g['document'] = prev
  }
}

function mountHud(): { parent: FakeEl; restore: () => void } {
  const restoreLs = stubLocalStorage()
  const restoreDoc = stubDocument()
  const parent = new FakeEl()
  // Elements carrying the `hidden` attribute in the mount() template.
  for (const sel of ['#hud-menu', '#hud-banner', '#hud-pvp-status', '#hud-tutorial', '#hud-tutorial-backdrop', '#hud-speed', '#hud-surrender']) {
    parent.primeHidden(sel)
  }
  const hud = new HudImpl()
  hud.mount(parent as unknown as HTMLElement)
  return {
    parent,
    restore: () => {
      restoreLs()
      restoreDoc()
    },
  }
}

// ---------------------------------------------------------------------------
// Defect #1: tutorial is on-demand only, dismissible three ways
// ---------------------------------------------------------------------------

suite('experience-fixes: tutorial on-demand only')

test('tutorial NEVER auto-shows on mount (no seen flag)', () => {
  const { parent, restore } = mountHud()
  try {
    assertEqual(parent.querySelector('#hud-tutorial').hidden, true, 'tutorial hidden at boot')
    assertEqual(parent.querySelector('#hud-tutorial-backdrop').hidden, true, 'backdrop hidden at boot')
  } finally {
    restore()
  }
})

test('Help opens the tutorial; the ✕ dismisses it', () => {
  const { parent, restore } = mountHud()
  try {
    parent.querySelector('#hud-help').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, false, 'open after Help')
    assertEqual(parent.querySelector('#hud-tutorial-backdrop').hidden, false, 'backdrop shown with card')
    parent.querySelector('#hud-tutorial-x').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, true, 'dismissed via ✕')
    assertEqual(parent.querySelector('#hud-tutorial-backdrop').hidden, true, 'backdrop dismissed via ✕')
  } finally {
    restore()
  }
})

test('"Got it!" dismisses the tutorial', () => {
  const { parent, restore } = mountHud()
  try {
    parent.querySelector('#hud-help').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, false, 'open after Help')
    parent.querySelector('#hud-tutorial-close').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, true, 'dismissed via Got it!')
    assertEqual(parent.querySelector('#hud-tutorial-backdrop').hidden, true, 'backdrop dismissed too')
  } finally {
    restore()
  }
})

test('tapping the backdrop (outside the card) dismisses the tutorial', () => {
  const { parent, restore } = mountHud()
  try {
    parent.querySelector('#hud-help').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, false, 'open after Help')
    parent.querySelector('#hud-tutorial-backdrop').click()
    assertEqual(parent.querySelector('#hud-tutorial').hidden, true, 'dismissed via backdrop tap')
  } finally {
    restore()
  }
})

test('tutorial CSS keeps the card tappable, centred and inside the viewport', () => {
  const css = readRepoFile('src/style.css')
  const rule = /\.hud-tutorial\{([^}]*)\}/.exec(css)
  assert(rule !== null, '.hud-tutorial rule exists')
  const body = rule?.[1] ?? ''
  assert(/position\s*:\s*fixed/.test(body), 'card is viewport-fixed (not centred on the short HUD root)')
  assert(/pointer-events\s*:\s*auto/.test(body), 'card opts back into pointer events')
  assert(/max-height\s*:/.test(body), 'card height is capped to the viewport')
  assert(/overflow-y\s*:\s*auto/.test(body), 'card scrolls internally instead of overflowing')
  assert(css.includes('.hud-tutorial-backdrop'), 'backdrop style exists')
  assert(css.includes('.hud-build-stamp'), 'build stamp style exists')
})

test('deploy pipeline ships the CSS and the build stamp (root-cause guard)', () => {
  const script = readDeployScript()
  if (script === null) return // pipeline lives outside the repo in some environments
  assert(script.includes('krts-deploy-bundle.css'), 'deploy reads the esbuild CSS output')
  assert(script.includes('</style>'), 'deploy replaces the <style> block')
  assert(script.includes('__BUILD_STAMP__'), 'deploy injects the build stamp')
})

// ---------------------------------------------------------------------------
// Defect #5: build stamp
// ---------------------------------------------------------------------------

suite('experience-fixes: build stamp')

test('build stamp placeholder + HUD wiring', () => {
  assertEqual(BUILD_STAMP, '__BUILD_STAMP__', 'source carries the placeholder the deploy replaces')
  assertEqual(BUILD_STAMP_LABEL, 'dev build', 'unstamped builds label themselves as dev')
  const hud = readRepoFile('src/ui/hud.ts')
  assert(hud.includes('id="hud-build-stamp"'), 'HUD renders the stamp element')
  assert(hud.includes('BUILD_STAMP_LABEL'), 'HUD fills the stamp from build-stamp.ts')
  const { parent, restore } = mountHud()
  try {
    assertEqual(parent.querySelector('#hud-build-stamp').textContent, 'dev build', 'stamp text set on mount')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Defect #3: pinch-to-zoom gesture math + controller integration
// ---------------------------------------------------------------------------

suite('experience-fixes: pinch gesture math')

test('spreading fingers zooms in about the midpoint', () => {
  const step = pinchStep({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 100, y: 100 }, { x: 300, y: 100 })
  assertClose(step.factor, 2, 1e-9, 'distance 100 -> 200 doubles the zoom')
  assertClose(step.midX, 200, 1e-9, 'anchor is the new midpoint x')
  assertClose(step.midY, 100, 1e-9, 'anchor is the new midpoint y')
})

test('pinching fingers together zooms out', () => {
  const step = pinchStep({ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 150, y: 100 }, { x: 250, y: 100 })
  assertClose(step.factor, 0.5, 1e-9, 'distance 200 -> 100 halves the zoom')
  assertClose(step.midX, 200, 1e-9, 'midpoint stays centred')
})

test('constant-distance two-finger drag pans by the midpoint delta, factor 1', () => {
  const step = pinchStep({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 140, y: 130 }, { x: 240, y: 130 })
  assertClose(step.factor, 1, 1e-9, 'no distance change -> no zoom')
  assertClose(step.panDx, 40, 1e-9, 'pan follows midpoint x')
  assertClose(step.panDy, 30, 1e-9, 'pan follows midpoint y')
})

test('degenerate zero-distance gesture is a no-op zoom', () => {
  const step = pinchStep({ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 60, y: 60 }, { x: 60, y: 60 })
  assertClose(step.factor, 1, 1e-9, 'zero previous distance -> factor 1 (no NaN zoom)')
})

interface GestureHandlers {
  onDown(e: unknown): void
  onMove(e: unknown): void
  onUp(e: unknown): void
}

function gestureSetup() {
  const world = makeWorld()
  const calls = {
    pan: [] as Array<{ dx: number; dy: number }>,
    zoom: [] as Array<{ factor: number; x?: number; y?: number }>,
    setSelection: [] as number[][],
  }
  const renderer = {
    setSelection(sel: number[]) {
      calls.setSelection.push([...sel])
    },
    setSelectionBox(_box: unknown) {},
    screenToWorld(sx: number, sy: number) {
      return { x: sx, z: sy }
    },
    getZoom() {
      return 8
    },
    pan(dx: number, dy: number) {
      calls.pan.push({ dx, dy })
    },
    zoomBy(factor: number, x?: number, y?: number) {
      calls.zoom.push({ factor, x, y })
    },
    centerOn(_x: number, _z: number) {},
  }
  const input = new InputControllerImpl()
  const internals = input as unknown as { world: unknown; renderer: unknown } & GestureHandlers
  internals.world = world
  internals.renderer = renderer
  const ev = (pointerId: number, x: number, y: number, button = 0) => ({
    pointerId,
    offsetX: x,
    offsetY: y,
    button,
    pointerType: 'touch',
  })
  return { input: internals, calls, ev }
}

test('controller: pinch spread calls zoomBy with the distance factor at the midpoint', () => {
  const { input, calls, ev } = gestureSetup()
  input.onDown(ev(1, 100, 100))
  input.onDown(ev(2, 200, 100))
  input.onMove(ev(2, 300, 100)) // distance 100 -> 200, midpoint 150 -> 200
  assertEqual(calls.zoom.length, 1, 'one zoomBy call')
  assertClose(calls.zoom[0].factor, 2, 1e-9, 'zoom factor is the distance ratio')
  assertClose(calls.zoom[0].x ?? -1, 200, 1e-9, 'zoom anchored at gesture midpoint x')
  assertClose(calls.zoom[0].y ?? -1, 100, 1e-9, 'zoom anchored at gesture midpoint y')
  assertEqual(calls.pan.length, 1, 'midpoint movement also pans')
  assertClose(calls.pan[0].dx, 50, 1e-9, 'pan dx is the midpoint delta')
})

test('controller: constant-distance drag pans and never zooms', () => {
  const { input, calls, ev } = gestureSetup()
  input.onDown(ev(1, 100, 100))
  input.onDown(ev(2, 200, 100))
  input.onMove(ev(1, 140, 100)) // both fingers shift +40 across two events
  input.onMove(ev(2, 240, 100))
  const totalPan = calls.pan.reduce((s, p) => s + p.dx, 0)
  assertClose(totalPan, 40, 1e-9, 'total pan equals the drag distance')
  const factorProduct = calls.zoom.reduce((s, z) => s * z.factor, 1)
  assertClose(factorProduct, 1, 1e-9, 'net zoom is 1 for a pure pan drag')
})

test('controller: lifting fingers after a pinch does not fire a tap', () => {
  const { input, calls, ev } = gestureSetup()
  input.onDown(ev(1, 100, 100))
  input.onDown(ev(2, 200, 100))
  input.onMove(ev(2, 320, 100)) // pinch out
  input.onUp(ev(2, 320, 100))
  input.onUp(ev(1, 100, 100)) // final release — must NOT tap-select/deselect
  assertEqual(calls.setSelection.length, 0, 'no selection change from the pinch-end release')
})

// ---------------------------------------------------------------------------
// Defect #2: one consistent render — fog covers beyond the world square,
// camera cannot be lost off-map
// ---------------------------------------------------------------------------

suite('experience-fixes: fog coverage + camera clamp')

interface FillRec {
  style: string
  x: number
  y: number
  w: number
  h: number
}

function makeRecordingRenderer(cssW: number, cssH: number) {
  const fills: FillRec[] = []
  let images = 0
  const ctx = {
    fillStyle: '',
    setTransform(_a: number, _b: number, _c: number, _d: number, _e: number, _f: number) {},
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: this.fillStyle, x, y, w, h })
    },
    drawImage(_img: unknown, _x: number, _y: number, _w: number, _h: number) {
      images += 1
    },
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  const g = globalThis as Record<string, unknown>
  const prevDoc = g['document']
  const prevWin = g['window']
  g['document'] = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: () => {} }) }),
  }
  g['window'] = { devicePixelRatio: 1 }
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement)
  renderer.resize(cssW, cssH)
  return {
    renderer,
    fills,
    imageCount: () => images,
    restore: () => {
      if (prevDoc === undefined) delete g['document']
      else g['document'] = prevDoc
      if (prevWin === undefined) delete g['window']
      else g['window'] = prevWin
    },
  }
}

function coveredBy(fills: FillRec[], style: string, px: number, py: number): boolean {
  return fills.some((f) => f.style === style && px >= f.x && px < f.x + f.w && py >= f.y && py < f.y + f.h)
}

test('fog covers the viewport beyond the world square (no naked ground zone)', () => {
  const { renderer, fills, imageCount, restore } = makeRecordingRenderer(412, 915)
  try {
    const world = new World()
    // Camera parked on the world corner, zoomed out: the square occupies
    // only part of the screen — the exact state behind the split render.
    renderer.centerOn(90, 90, 2)
    const r = renderer as unknown as { drawFog(w: World, t: 0 | 1): void }
    r.drawFog(world, 0)
    assertEqual(imageCount(), 1, 'fog cache composited once')
    assert(coveredBy(fills, FOG_UNEXPLORED_FILL, 400, 10), 'top-right (outside square) is unexplored black')
    assert(coveredBy(fills, FOG_UNEXPLORED_FILL, 400, 900), 'bottom-right (outside square) is unexplored black')
    assert(coveredBy(fills, FOG_UNEXPLORED_FILL, 400, 300), 'right strip (outside square) is unexplored black')
    assert(!coveredBy(fills, FOG_UNEXPLORED_FILL, 100, 300), 'inside the square is NOT overpainted')
  } finally {
    restore()
  }
})

test('camera is clamped near the world so the map cannot be lost', () => {
  const { renderer, restore } = makeRecordingRenderer(412, 915)
  try {
    renderer.centerOn(9999, -9999, 8)
    const centre = renderer.screenToWorld(206, 457.5)
    assertEqual(centre.x, 170, 'camX clamped to the world margin')
    assertEqual(centre.z, -170, 'camZ clamped to the world margin')
    renderer.pan(100000, 0) // fling far past the opposite edge
    const after = renderer.screenToWorld(206, 457.5)
    assertEqual(after.x, -170, 'pan is clamped too')
  } finally {
    restore()
  }
})
