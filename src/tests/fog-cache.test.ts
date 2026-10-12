/**
 * Fog-of-war cache invalidation regression tests.
 *
 * Background: the renderer caches the fog bitmap and used to rebuild it on a
 * fixed 20-frame cadence. A cache built before the first vision update (boot,
 * save load, low-framerate environments) lingered as a full black screen
 * (#040806 over the whole viewport) until the next scheduled rebuild.
 * FogGrid now carries a revision counter bumped whenever rendered fog content
 * changes, and the renderer rebuilds when the revision moves.
 */
import { FogGrid } from '../world/fog.ts'
import { Renderer } from '../render/renderer.ts'
import { World, TEAM_PLAYER } from '../core/World.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('FogGrid.revision')

test('starts at 0', () => {
  const fog = new FogGrid()
  assertEqual(fog.revision, 0, 'initial revision')
})

test('endUpdate() bumps revision only when the visible set changes', () => {
  const fog = new FogGrid()
  fog.beginUpdate()
  fog.reveal(0, 0, 10)
  fog.endUpdate()
  const afterFirst = fog.revision
  assert(afterFirst > 0, 'revision bumped by first reveal')

  // Identical scene next update: demote + re-reveal the same cells.
  fog.beginUpdate()
  fog.reveal(0, 0, 10)
  fog.endUpdate()
  assertEqual(fog.revision, afterFirst, 'no bump when visible set is unchanged')

  // New area revealed: visible set grows.
  fog.beginUpdate()
  fog.reveal(0, 0, 10)
  fog.reveal(60, 60, 10)
  fog.endUpdate()
  assert(fog.revision > afterFirst, 'revision bumped when visible set grows')

  // Unit moved away: previously visible cells demoted to explored.
  const grown = fog.revision
  fog.beginUpdate()
  fog.reveal(60, 60, 10) // only the far area still visible
  fog.endUpdate()
  assert(fog.revision > grown, 'revision bumped when visible set shrinks')
})

test('beginUpdate() with nothing visible is a no-op for revision', () => {
  const fog = new FogGrid()
  fog.beginUpdate()
  fog.endUpdate()
  assertEqual(fog.revision, 0, 'no bump on empty update')
})

test('restore paths bump revision', () => {
  const fog = new FogGrid()
  fog.beginUpdate()
  fog.reveal(0, 0, 10)
  fog.endUpdate()
  const before = fog.revision
  fog.restoreCells(fog.snapshotCells())
  assert(fog.revision > before, 'restoreCells bumps revision')
  const before2 = fog.revision
  fog.restoreVisibleNow(fog.snapshotVisibleNow())
  assert(fog.revision > before2, 'restoreVisibleNow bumps revision')
})

test('vision system drives revision through the sim', () => {
  const world = new World()
  world.registerSystem(new VisionSystemImpl())
  // One entity with sight at the origin.
  const id = world.spawnUnit('worker', TEAM_PLAYER, 0, 0).id
  world.sight[id] = 12
  const before = world.fog[0].revision
  world.update(1 / 60)
  assert(world.fog[0].revision > before, 'first vision update reveals and bumps')
  const settled = world.fog[0].revision
  // Two more updates with nothing moving: visible set demotes once, then stable.
  world.update(1 / 60)
  world.update(1 / 60)
  // Revision may bump once for the demotion, but must not grow every step.
  const r1 = world.fog[0].revision
  world.update(1 / 60)
  world.update(1 / 60)
  assertEqual(world.fog[0].revision, r1, 'stable scene: no revision churn per step')
  assert(settled <= r1, 'sanity')
})

suite('Renderer fog cache invalidation')

interface FakeCtx {
  fillRectCalls: number
  drawImageCalls: number
  fillRect(x: number, y: number, w: number, h: number): void
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void
  fillStyle: string
}

function makeFakeCtx(): FakeCtx {
  return {
    fillRectCalls: 0,
    drawImageCalls: 0,
    fillStyle: '',
    fillRect(_x: number, _y: number, _w: number, _h: number): void {
      this.fillRectCalls += 1
    },
    drawImage(_img: unknown, _x: number, _y: number, _w: number, _h: number): void {
      this.drawImageCalls += 1
    },
  }
}

function makeFakeCanvas(ctx: FakeCtx): HTMLCanvasElement {
  return {
    width: 420,
    height: 800,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement
}

/** Installs a document stub that counts offscreen canvas creation (fog cache builds). */
function stubDocument(): { builds: () => number; restore: () => void } {
  let builds = 0
  const prev = (globalThis as Record<string, unknown>)['document']
  const fakeDocument = {
    createElement: (tag: string) => {
      if (tag === 'canvas') builds += 1
      const ctx = makeFakeCtx()
      return {
        width: 0,
        height: 0,
        getContext: () => ctx,
      }
    },
  }
  ;(globalThis as Record<string, unknown>)['document'] = fakeDocument
  return {
    builds: () => builds,
    restore: () => {
      if (prev === undefined) delete (globalThis as Record<string, unknown>)['document']
      else (globalThis as Record<string, unknown>)['document'] = prev
    },
  }
}

function makeRenderer(): { renderer: Renderer; stub: { builds: () => number; restore: () => void } } {
  const stub = stubDocument()
  const renderer = new Renderer(makeFakeCanvas(makeFakeCtx()))
  return { renderer, stub }
}

test('cache builds on first draw, then stays cached without fog changes', () => {
  const { renderer, stub } = makeRenderer()
  try {
    const world = new World()
    ;(renderer as unknown as { frame: number }).frame = 100
    ;(renderer as unknown as { drawFog(w: World, t: 0 | 1): void }).drawFog(world, 0)
    assertEqual(stub.builds(), 1, 'first drawFog builds the cache')
    ;(renderer as unknown as { frame: number }).frame = 101
    ;(renderer as unknown as { drawFog(w: World, t: 0 | 1): void }).drawFog(world, 0)
    assertEqual(stub.builds(), 1, 'no rebuild without fog change')
  } finally {
    stub.restore()
  }
})

test('fog revision change triggers a rebuild (stale-cache regression)', () => {
  const { renderer, stub } = makeRenderer()
  try {
    const world = new World()
    const r = renderer as unknown as { frame: number; drawFog(w: World, t: 0 | 1): void }
    r.frame = 100
    r.drawFog(world, 0) // cache built while fog is fully unexplored
    assertEqual(stub.builds(), 1, 'initial build')
    // Vision reveals the base area AFTER the cache was built — the old code
    // would keep showing the stale all-black cache for up to 20 frames.
    world.fog[0].beginUpdate()
    world.fog[0].reveal(-40, -40, 24)
    world.fog[0].endUpdate()
    r.frame = 101
    r.drawFog(world, 0)
    assertEqual(stub.builds(), 2, 'rebuild on fog revision change')
    // Stable afterwards: no churn.
    r.frame = 102
    r.drawFog(world, 0)
    assertEqual(stub.builds(), 2, 'no rebuild once cache matches revision')
  } finally {
    stub.restore()
  }
})

test('20-frame cap still rebuilds as a backstop', () => {
  const { renderer, stub } = makeRenderer()
  try {
    const world = new World()
    const r = renderer as unknown as { frame: number; drawFog(w: World, t: 0 | 1): void }
    r.frame = 100
    r.drawFog(world, 0)
    assertEqual(stub.builds(), 1, 'initial build')
    r.frame = 121 // 21 frames later, fog untouched
    r.drawFog(world, 0)
    assertEqual(stub.builds(), 2, 'periodic rebuild backstop preserved')
  } finally {
    stub.restore()
  }
})
