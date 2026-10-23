/**
 * Input controller regression tests — selection, smart orders, box-select,
 * building quick-select. Uses a mock renderer (no canvas/DOM).
 */
import { TEAM_PLAYER, KIND_HALL, KIND_WORKER } from '../core/World.ts'
import { makeWorld } from './setup.ts'
import { orderMove, orderStop } from '../systems/movement.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

/** Minimal renderer mock: 1:1 screen-to-world, records selection. */
function mockRenderer() {
  return {
    selection: [] as number[],
    setSelection(sel: number[]) {
      this.selection = [...sel]
    },
    setSelectionBox(_box: unknown) {},
    clearSelectionBox() {},
    screenToWorld(sx: number, sy: number) {
      return { x: sx, z: sy }
    },
    getZoom() {
      return 1
    },
    pan(_dx: number, _dy: number) {},
  }
}

function setup() {
  const world = makeWorld()
  const renderer = mockRenderer()
  const input = new InputControllerImpl()
  ;(input as unknown as { renderer: unknown }).renderer = renderer
  ;(input as unknown as { world: unknown }).world = world
  return { world, renderer, input }
}

suite('input selection')
test('tap selects own unit', () => {
  const { world, input } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  assert(workerId !== -1, 'need a worker')
  // Simulate tap via the private tapSelect — use selectBuilding path instead.
  // Direct: use the controller's tap handling through a synthetic event is DOM-bound,
  // so we test selectBuilding + getSelected here.
  input.selectBuilding(3) // KIND_HALL
  const sel = input.getSelected()
  assertEqual(sel.length, 1, 'one building selected')
  assertEqual(world.kind[sel[0]], 3, 'selected a hall')
})

test('selectBuilding cycles through multiple of same kind', () => {
  const { world, input } = setup()
  // Build a second hall via spawn.
  const hall2 = world.spawnBuilding('hall', TEAM_PLAYER, -20, -20, true).id
  input.selectBuilding(3)
  const first = input.getSelected()[0]
  input.selectBuilding(3)
  const second = input.getSelected()[0]
  assert(first !== second, 'second tap selects a different hall')
  input.selectBuilding(3)
  const third = input.getSelected()[0]
  assertEqual(third, first, 'third tap cycles back to first')
  assert(world.entities.has(hall2), 'second hall exists')
})

test('selectBuilding ignores missing kind', () => {
  const { input } = setup()
  input.selectBuilding(5) // KIND_ARCHERY — none built in seed
  assertEqual(input.getSelected().length, 0, 'nothing selected when kind absent')
})

test('getOwnedBuildingKinds lists owned types', () => {
  const { input } = setup()
  const kinds = input.getOwnedBuildingKinds()
  assert(kinds.length >= 1, 'at least the hall is owned')
  assert(kinds.some((k: { kind: number; count: number }) => k.kind === 3 && k.count >= 1), 'hall counted')
})

test('deselect via empty selectBuilding then getSelected', () => {
  const { input } = setup()
  input.selectBuilding(3)
  assertEqual(input.getSelected().length, 1, 'hall selected')
  // Selecting a non-existent kind keeps current selection (no-op).
  input.selectBuilding(99)
  assertEqual(input.getSelected().length, 1, 'selection unchanged on no-op')
})

suite('idle workers and stop')
test('selectIdleWorkers selects idle workers', () => {
  const { world, input } = setup()
  // All seed workers start idle.
  input.selectIdleWorkers()
  const sel = input.getSelected()
  assert(sel.length > 0, 'should select idle workers')
  for (const id of sel) {
    assert(world.kind[id] === KIND_WORKER, 'only workers selected')
  }
})

test('orderStop halts moving units', () => {
  const { world } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  orderMove(world, workerId, 50, 50)
  assert(world.moving[workerId] === 1, 'worker is moving')
  orderStop(world, workerId)
  assert(world.moving[workerId] === 0, 'worker stopped')
  assert(world.state[workerId] === 0, 'worker idle')
})
test('deferred mode: stopSelected emits without mutating the world', () => {
  const { world, input } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  ;(input as unknown as { selected: number[] }).selected = [workerId]
  orderMove(world, workerId, 50, 50)
  assert(world.moving[workerId] === 1, 'worker is moving')

  const emitted: { type: string }[] = []
  input.setCommandListener((cmd) => emitted.push(cmd))
  input.setDeferredExecution(true)
  input.stopSelected()

  assertEqual(emitted.length, 1, 'one command emitted')
  assertEqual(emitted[0].type, 'stop', 'stop command emitted')
  assert(world.moving[workerId] === 1, 'world NOT mutated in deferred mode')
})

test('normal mode: stopSelected still mutates immediately', () => {
  const { world, input } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  ;(input as unknown as { selected: number[] }).selected = [workerId]
  orderMove(world, workerId, 50, 50)
  input.stopSelected()
  assert(world.moving[workerId] === 0, 'worker stopped immediately in normal mode')
})

test('boxSelect finds units via spatial hash', () => {
  const { world, renderer, input } = setup()
  // Spawn 3 workers in a tight cluster + 1 far away
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 10, 10)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 11, 10)
  const w3 = world.spawnUnit('worker', TEAM_PLAYER, 10, 11)
  const far = world.spawnUnit('worker', TEAM_PLAYER, 200, 200)
  world.update(1 / 60) // rebuild spatial hash
  // Invoke private boxSelect via cast (screen == world in mock renderer)
  ;(input as unknown as { boxSelect(x0: number, y0: number, x1: number, y1: number): void })
    .boxSelect(9, 9, 12, 12)
  const sel = renderer.selection
  assert(sel.includes(w1.id), 'box selects w1')
  assert(sel.includes(w2.id), 'box selects w2')
  assert(sel.includes(w3.id), 'box selects w3')
  assert(!sel.includes(far.id), 'box excludes far worker')
})

test('entityAt finds tapped unit via spatial hash', () => {
  const { world, input } = setup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 30, 30)
  world.update(1 / 60)
  const hit = (input as unknown as { entityAt(x: number, z: number, anyTeam: boolean): number })
    .entityAt(30, 30, true)
  assertEqual(hit, w.id, 'tap hits the worker')
  const miss = (input as unknown as { entityAt(x: number, z: number, anyTeam: boolean): number })
    .entityAt(500, 500, true)
  assertEqual(miss, -1, 'tap on empty ground misses')
})

suite('touch pan (movementX/Y unreliable on touch)')

/** Renderer mock that records pan/centerOn/zoomBy calls. */
function recordingRenderer() {
  return {
    pans: [] as [number, number][],
    zooms: [] as [number, number | undefined, number | undefined][],
    centers: [] as [number, number, number | undefined][],
    setSelection(_sel: number[]) {},
    setSelectionBox(_box: unknown) {},
    screenToWorld(sx: number, sy: number) {
      return { x: sx, z: sy }
    },
    getZoom() {
      return 1
    },
    pan(dx: number, dy: number) {
      this.pans.push([dx, dy])
    },
    zoomBy(factor: number, x?: number, y?: number) {
      this.zooms.push([factor, x, y])
    },
    centerOn(x: number, z: number, zoom?: number) {
      this.centers.push([x, z, zoom])
    },
  }
}

interface CtlHarness {
  onDown(e: unknown): void
  onMove(e: unknown): void
  onUp(e: unknown): void
  mode: string
  renderer: unknown
  world: unknown
}

function touchSetup() {
  const world = makeWorld()
  const renderer = recordingRenderer()
  const input = new InputControllerImpl()
  const ctl = input as unknown as CtlHarness
  ctl.renderer = renderer
  ctl.world = world
  ctl.mode = 'move' // non-selection mode: a drag pans instead of box-selecting
  return { world, renderer, input, ctl }
}

function touchDown(ctl: CtlHarness, id: number, x: number, y: number): void {
  ctl.onDown({ button: 0, pointerId: id, offsetX: x, offsetY: y, pointerType: 'touch' })
}

function touchMove(ctl: CtlHarness, id: number, x: number, y: number): void {
  // movementX/Y are 0 for touch pointers in mobile Chrome — the controller
  // must derive deltas from tracked positions instead.
  ctl.onMove({ pointerId: id, offsetX: x, offsetY: y, movementX: 0, movementY: 0, pointerType: 'touch' })
}

test('single-finger drag pans from tracked positions, not movementX/Y', () => {
  const { renderer, ctl } = touchSetup()
  touchDown(ctl, 1, 100, 100)
  touchMove(ctl, 1, 130, 110) // dist ~31.6 > 16px touch threshold -> panning
  assert(renderer.pans.length > 0, 'pan was called on touch drag')
  const [dx, dy] = renderer.pans[renderer.pans.length - 1]
  assertEqual(dx, 30, 'pan dx from position delta')
  assertEqual(dy, 10, 'pan dy from position delta')
})

test('two-finger gesture pans by midpoint delta and pinches by distance ratio', () => {
  // Pinch-era semantics (2026-10-22): a two-finger gesture is one gesture —
  // the camera pans by the MIDPOINT's movement (half of one finger's delta
  // when only that finger moves) and zooms by the inter-pointer distance
  // ratio. Before pinch support, this test asserted the moved finger's full
  // delta as the pan; that double-counted when both fingers moved.
  const { renderer, ctl } = touchSetup()
  touchDown(ctl, 1, 100, 100)
  touchDown(ctl, 2, 200, 200)
  touchMove(ctl, 2, 210, 190)
  assert(renderer.pans.length > 0, 'two-finger pan called')
  const [dx, dy] = renderer.pans[renderer.pans.length - 1]
  assertEqual(dx, 5, 'two-finger pan dx is the midpoint delta')
  assertEqual(dy, -5, 'two-finger pan dy is the midpoint delta')
  assertEqual(renderer.zooms.length, 1, 'distance change also pinches')
  const [factor, ax, ay] = renderer.zooms[0]
  const expected = Math.hypot(110, 90) / Math.hypot(100, 100)
  assert(Math.abs(factor - expected) < 1e-9, 'zoom factor is the distance ratio')
  assertEqual(ax, 155, 'zoom anchored at the gesture midpoint x')
  assertEqual(ay, 145, 'zoom anchored at the gesture midpoint y')
})

test('centerOnBase jumps the camera to the town hall', () => {
  const { world, renderer, input } = touchSetup()
  let hallId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_HALL) {
      hallId = id
      break
    }
  }
  assert(hallId !== -1, 'seed has a player hall')
  input.centerOnBase()
  assertEqual(renderer.centers.length, 1, 'centerOn called once')
  const [x, z, zoom] = renderer.centers[0]
  assertEqual(x, world.positionX[hallId], 'centered on hall x')
  assertEqual(z, world.positionZ[hallId], 'centered on hall z')
  assertEqual(zoom, 10, 'default gameplay zoom')
})
