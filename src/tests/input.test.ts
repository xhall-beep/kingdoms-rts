/**
 * Input controller regression tests — selection, smart orders, box-select,
 * building quick-select. Uses a mock renderer (no canvas/DOM).
 */
import { TEAM_PLAYER, KIND_HALL, KIND_WORKER, KIND_FARM, NO_TRAINING, HARVEST_OFF, HARVEST_WOOD, STATE_IDLE, STATE_BUILD, STATE_GATHER, STATE_MOVE, NO_TARGET } from '../core/World.ts'
import { isHeldWorker } from '../render/renderer.ts'
import { makeWorld, stepWorld, STEP } from './setup.ts'
import { orderMove, orderStop } from '../systems/movement.ts'
import { orderBuild, buildersOnSite, buildSurchargeAmount } from '../systems/gather.ts'
import { cancelTrainActive, cancelTrainQueued, enqueueTrain, productionCommittedSupply, trainQueueCount, trainingStateFor, trainingQueueFor, MAX_TRAIN_QUEUE } from '../systems/production.ts'
import { BUILDINGS } from '../data/buildings.ts'
import { placeStructure } from '../world/construction.ts'
import { applyCommand } from '../net/apply.ts'
import type { Command } from '../session/commands.ts'
import { FACTIONS } from '../data/factions.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { renderCommandCard, formatQueueRuns } from '../ui/command-card.ts'
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

suite('selection gestures: pan vs marquee disambiguation (touch)')

/**
 * Renderer mock for gesture tests: 1:1 screen==world, a 1000x1000 view
 * (so "on screen" = world coords in [0,1000]²), records pans and every
 * selection-box call.
 */
function gestureRenderer() {
  return {
    selection: [] as number[],
    pans: [] as [number, number][],
    boxes: [] as ({ x0: number; y0: number; x1: number; y1: number } | null)[],
    setSelection(sel: number[]) {
      this.selection = [...sel]
    },
    setSelectionBox(box: { x0: number; y0: number; x1: number; y1: number } | null) {
      this.boxes.push(box)
    },
    screenToWorld(sx: number, sy: number) {
      return { x: sx, z: sy }
    },
    getZoom() {
      return 1
    },
    getCssSize() {
      return { w: 1000, h: 1000 }
    },
    pan(dx: number, dy: number) {
      this.pans.push([dx, dy])
    },
    zoomBy(_f: number, _x?: number, _y?: number) {},
    centerOn(_x: number, _z: number, _zoom?: number) {},
    pingMove(_x: number, _z: number) {},
    pingAttack(_x: number, _z: number) {},
  }
}

interface GestureCtl {
  onDown(e: unknown): void
  onMove(e: unknown): void
  onUp(e: unknown): void
  mode: string
  selected: number[]
  renderer: unknown
  world: unknown
}

function gestureSetup() {
  const world = makeWorld()
  const renderer = gestureRenderer()
  const input = new InputControllerImpl()
  const ctl = input as unknown as GestureCtl
  ctl.renderer = renderer
  ctl.world = world
  return { world, renderer, input, ctl }
}

const gDown = (ctl: GestureCtl, x: number, y: number, t: number): void =>
  ctl.onDown({ button: 0, pointerId: 1, offsetX: x, offsetY: y, pointerType: 'touch', timeStamp: t })
const gMove = (ctl: GestureCtl, x: number, y: number, t: number): void =>
  ctl.onMove({ pointerId: 1, offsetX: x, offsetY: y, pointerType: 'touch', timeStamp: t })
const gUp = (ctl: GestureCtl, x: number, y: number, t: number): void =>
  ctl.onUp({ button: 0, pointerId: 1, offsetX: x, offsetY: y, pointerType: 'touch', timeStamp: t })
const gTap = (ctl: GestureCtl, x: number, y: number, t: number): void => {
  gDown(ctl, x, y, t)
  gUp(ctl, x, y, t + 50)
}

test('quick drag on empty ground pans the camera, never box-selects', () => {
  const { renderer, input, ctl } = gestureSetup()
  gDown(ctl, 500, 500, 0)
  gMove(ctl, 540, 500, 50) // 40px in 50ms: a quick drag -> pan
  gMove(ctl, 560, 500, 80)
  gUp(ctl, 560, 500, 100)
  assert(renderer.pans.length > 0, 'camera panned on quick drag')
  assert(
    renderer.boxes.every((b) => b === null),
    'no marquee box was ever drawn',
  )
  assertEqual(input.getSelected().length, 0, 'nothing selected by a pan')
})

test('hold, then drag on empty ground arms the marquee', () => {
  const { world, renderer, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 520, 520)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 550, 540)
  const far = world.spawnUnit('worker', TEAM_PLAYER, 700, 700)
  world.update(1 / 60)
  gDown(ctl, 500, 500, 0)
  gMove(ctl, 502, 501, 250) // held 250ms: marquee arms from the press point
  const armed = renderer.boxes[renderer.boxes.length - 1]
  assert(armed !== null && armed !== undefined, 'marquee box appeared after the hold')
  assertEqual(armed!.x0, 500, 'box anchored at the original press point')
  gMove(ctl, 560, 560, 300)
  gUp(ctl, 560, 560, 320)
  const sel = input.getSelected()
  assert(sel.includes(w1.id) && sel.includes(w2.id), 'box selected the workers inside')
  assert(!sel.includes(far.id), 'box excluded the worker outside')
})

test('drag starting on a friendly unit arms the marquee immediately', () => {
  const { world, renderer, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 300, 300)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 330, 330)
  world.update(1 / 60)
  // Press lands on w1 (within pick radius of its slightly drifted
  // post-tick position); the box starts a few px up-left so the drifted
  // worker is strictly inside it.
  gDown(ctl, 295, 295, 0)
  gMove(ctl, 320, 320, 40) // only 40ms in — no hold — but unit-anchored
  assert(
    renderer.boxes.some((b) => b !== null),
    'marquee armed immediately from a unit drag',
  )
  assertEqual(renderer.pans.length, 0, 'camera did not pan')
  gUp(ctl, 340, 340, 60)
  const sel = input.getSelected()
  assert(sel.includes(w1.id) && sel.includes(w2.id), 'box selected both workers')
})

suite('select all of kind on screen: double-tap and long-press')

test('double-tap a unit selects all of its kind on screen only', () => {
  const { world, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 160, 100)
  const wFar = world.spawnUnit('worker', TEAM_PLAYER, 1500, 1500) // off screen
  const m1 = world.spawnUnit('melee', TEAM_PLAYER, 300, 100) // different kind
  world.update(1 / 60)
  gTap(ctl, 100, 100, 1000)
  assertEqual(input.getSelected().length, 1, 'first tap selects the one worker')
  gTap(ctl, 100, 100, 1200) // second tap 200ms later: double-tap
  const sel = input.getSelected()
  assert(sel.includes(w1.id) && sel.includes(w2.id), 'both on-screen workers selected')
  assert(!sel.includes(wFar.id), 'off-screen worker of the same kind excluded')
  assert(!sel.includes(m1.id), 'different kind excluded')
  assertEqual(sel.length, 2, 'exactly the on-screen workers')
})

test('a slow second tap still toggles deselect (double-tap window is bounded)', () => {
  const { world, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  gTap(ctl, 100, 100, 1000)
  assertEqual(input.getSelected().length, 1, 'tap selects')
  gTap(ctl, 100, 100, 2000) // 1000ms later: outside the double-tap window
  assertEqual(input.getSelected().length, 0, 'slow re-tap deselects as before')
  assert(world.entities.has(w1.id), 'worker still exists')
})

test('long-press on a unit selects all of its kind on screen', () => {
  const { world, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 160, 100)
  const m1 = world.spawnUnit('melee', TEAM_PLAYER, 300, 100)
  world.update(1 / 60)
  gDown(ctl, 100, 100, 0)
  gUp(ctl, 100, 100, 500) // 500ms stationary press on the worker
  const sel = input.getSelected()
  assert(sel.includes(w1.id) && sel.includes(w2.id), 'long-press selected all on-screen workers')
  assert(!sel.includes(m1.id), 'different kind excluded')
})

test('held press on empty ground is an aborted marquee, not a move order', () => {
  const { world, input, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  gTap(ctl, 100, 100, 1000)
  assertEqual(input.getSelected().length, 1, 'worker selected')
  // The sim auto-tasks idle workers, so "no order from the hold" means the
  // worker's existing target survives untouched — not that it stands still.
  const tx = world.targetX[w.id]
  const tz = world.targetZ[w.id]
  gDown(ctl, 600, 600, 2000)
  gUp(ctl, 600, 600, 2400) // held 400ms on empty ground, released
  assertEqual(world.targetX[w.id], tx, 'no move order issued by the hold (target X unchanged)')
  assertEqual(world.targetZ[w.id], tz, 'no move order issued by the hold (target Z unchanged)')
  assertEqual(input.getSelected().length, 1, 'selection kept (no deselect either)')
})

test('quick tap on empty ground still issues the smart move order', () => {
  const { world, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  gTap(ctl, 100, 100, 1000)
  gTap(ctl, 600, 600, 2000) // quick tap with a unit selected: smart order
  assertEqual(world.moving[w.id], 1, 'worker ordered to move')
})

suite('group orders fan out through existing order paths')

test('modeOrder move fans out to every selected unit', () => {
  const { world, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const m = world.spawnUnit('melee', TEAM_PLAYER, 160, 100)
  world.update(1 / 60)
  ctl.selected = [w.id, m.id]
  ctl.mode = 'move' // direct field set (setMode touches the DOM banner)
  // modeOrder ends in setMode('selection'), which updates the DOM banner —
  // run the tap under the fake document (getElementById -> null = no-op).
  withFakeDocument(() => {
    gTap(ctl, 600, 600, 0)
  })
  assertEqual(world.moving[w.id], 1, 'worker moving')
  assertEqual(world.moving[m.id], 1, 'melee moving')
})

test('stopSelected halts a whole group', () => {
  const { world, input, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const m = world.spawnUnit('melee', TEAM_PLAYER, 160, 100)
  world.update(1 / 60)
  orderMove(world, w.id, 500, 500)
  orderMove(world, m.id, 500, 500)
  ctl.selected = [w.id, m.id]
  input.stopSelected()
  assertEqual(world.moving[w.id], 0, 'worker stopped')
  assertEqual(world.moving[m.id], 0, 'melee stopped')
})

suite('group command card')

interface FakeEl {
  children: FakeEl[]
  style: Record<string, string>
  className: string
  textContent: string
  innerHTML: string
  disabled: boolean
  appendChild(c: FakeEl): FakeEl
  addEventListener(): void
}

function fakeEl(): FakeEl {
  return {
    children: [],
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    appendChild(c: FakeEl) {
      this.children.push(c)
      return c
    },
    addEventListener() {},
  }
}

function collectText(el: FakeEl): string {
  return [el.textContent, ...el.children.map(collectText)].join(' ')
}

function buttonLabels(el: FakeEl): string[] {
  const out: string[] = []
  const walk = (n: FakeEl): void => {
    if (n.className === 'cmd-btn' && n.children.length > 0) out.push(n.children[0].textContent)
    for (const c of n.children) walk(c)
  }
  walk(el)
  return out
}

const cardCallbacks = {
  onMode(_m: string) {},
  onStop() {},
  onHold() {},
  onBuildType(_t: string) {},
  onTrain(_t: string) {},
  onResearch(_t: string) {},
  onMilitia() {},
  onUpgrade() {},
  onWarHorn(_r: 1 | 2 | 3) {},
  onToggleBuild() {},
}

/** Install a minimal document stub for the card's createElement calls. */
function withFakeDocument<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>
  const prev = g['document']
  g['document'] = { createElement: () => fakeEl(), getElementById: () => null }
  try {
    return fn()
  } finally {
    if (prev === undefined) delete g['document']
    else g['document'] = prev
  }
}

test('group card: counts by class, aggregate HP, union command row', () => {
  const { world } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 160, 100)
  const m1 = world.spawnUnit('melee', TEAM_PLAYER, 300, 100)
  world.update(1 / 60)
  const ids = [w1.id, w2.id, m1.id]
  const hpOf = (): string => {
    let hp = 0
    let max = 0
    for (const id of ids) {
      hp += Math.max(0, Math.floor(world.health[id]))
      max += Math.floor(world.maxHealth[id])
    }
    return `${hp}/${max}`
  }
  withFakeDocument(() => {
    const el = fakeEl()
    const shown = renderCommandCard(el as never, world, ids, cardCallbacks as never, {})
    assert(shown, 'group card rendered')
    const text = collectText(el)
    assert(text.includes('3 units'), 'group title counts the selection')
    assert(text.includes('2 Peasant'), 'worker class count with faction name')
    assert(text.includes('1 Footman'), 'melee class count with faction name')
    assert(text.includes(hpOf()), 'aggregate HP shown for the whole group')
    const labels = buttonLabels(el)
    for (const want of ['Move', 'Attack', 'Stop', 'Gather', 'Patrol', 'Hold']) {
      assert(labels.includes(want), `group command row includes ${want}`)
    }
    assert(!labels.some((l) => l.startsWith('Build')), 'mixed group has no Build button')
  })
  // Aggregate HP moves when ANY member takes damage.
  world.health[m1.id] -= 40
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, ids, cardCallbacks as never, {})
    assert(collectText(el).includes(hpOf()), 'aggregate HP reflects member damage')
  })
})

test('all-worker group keeps Gather and the Build expander, no military commands', () => {
  const { world } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 160, 100)
  world.update(1 / 60)
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [w1.id, w2.id], cardCallbacks as never, {})
    const labels = buttonLabels(el)
    assert(labels.includes('Gather'), 'worker group can gather')
    assert(labels.some((l) => l.startsWith('Build')), 'worker group keeps Build expander')
    assert(!labels.includes('Patrol') && !labels.includes('Hold'), 'no military commands')
  })
})

test('single selection still renders the single card, not the group card', () => {
  const { world } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [w1.id], cardCallbacks as never, {})
    const text = collectText(el)
    assert(text.includes('Peasant'), 'single card shows the unit name')
    assert(!text.includes('1 units'), 'single card is not the group summary')
  })
})

suite('playtest fixes v1: gesture-mode toggle, deselect, cancel, authoritative stop')

test('gesture mode defaults to Move', () => {
  const { input } = gestureSetup()
  assertEqual(input.getGestureMode(), 'move', 'default drag intent is Move (pan)')
})

test('Select mode: a quick drag on empty ground boxes immediately, never pans', () => {
  const { world, renderer, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 520, 520)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 550, 540)
  world.update(1 / 60)
  input.setGestureMode('select')
  gDown(ctl, 500, 500, 0)
  gMove(ctl, 560, 560, 50) // 50ms: quick — in Move mode this would pan
  const armed = renderer.boxes[renderer.boxes.length - 1]
  assert(armed !== null && armed !== undefined, 'marquee armed on the first drag frame in Select mode')
  assertEqual(renderer.pans.length, 0, 'camera did not pan in Select mode')
  gUp(ctl, 560, 560, 80)
  const sel = input.getSelected()
  assert(sel.includes(w1.id) && sel.includes(w2.id), 'box selected the workers inside')
})

test('Move mode: a quick drag on empty ground still pans, never boxes', () => {
  const { renderer, input, ctl } = gestureSetup()
  input.setGestureMode('move')
  gDown(ctl, 500, 500, 0)
  gMove(ctl, 540, 500, 50)
  gUp(ctl, 540, 500, 80)
  assert(renderer.pans.length > 0, 'camera panned on quick drag in Move mode')
  assert(renderer.boxes.every((b) => b === null), 'no marquee box was ever drawn')
})

test('Select mode: tap still selects a unit', () => {
  const { world, input, ctl } = gestureSetup()
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  input.setGestureMode('select')
  gTap(ctl, 100, 100, 1000)
  assertEqual(input.getSelected().length, 1, 'tap selects in Select mode')
  assertEqual(input.getSelected()[0], w1.id, 'the tapped worker is selected')
})

test('pinch zoom works in both gesture modes and never draws a box', () => {
  for (const mode of ['move', 'select'] as const) {
    const world = makeWorld()
    const zooms: number[] = []
    const boxes: (unknown | null)[] = []
    const renderer = {
      ...gestureRenderer(),
      zoomBy(f: number) {
        zooms.push(f)
      },
      setSelectionBox(box: unknown | null) {
        boxes.push(box)
      },
    }
    const input = new InputControllerImpl()
    const ctl = input as unknown as GestureCtl
    ctl.renderer = renderer
    ctl.world = world
    input.setGestureMode(mode)
    // Two fingers down, then spread them: distance 100 -> 200.
    ctl.onDown({ button: 0, pointerId: 1, offsetX: 100, offsetY: 100, pointerType: 'touch', timeStamp: 0 })
    ctl.onDown({ button: 0, pointerId: 2, offsetX: 200, offsetY: 100, pointerType: 'touch', timeStamp: 10 })
    ctl.onMove({ pointerId: 2, offsetX: 300, offsetY: 100, pointerType: 'touch', timeStamp: 20 })
    assert(zooms.length > 0, `pinch zoomed in ${mode} mode`)
    assert(zooms.some((f) => f > 1), `pinch-out zoomed in in ${mode} mode`)
    assert(boxes.every((b) => b === null), `two fingers never box in ${mode} mode`)
  }
})

test('deselect clears the selection and disarms the mode, issuing no order', () => {
  const { world, input, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  gTap(ctl, 100, 100, 1000)
  assertEqual(input.getSelected().length, 1, 'worker selected')
  // Give the worker a live move order, then arm an order mode: deselect
  // must change NEITHER (no stop, no new order) — it only clears state.
  orderMove(world, w.id, 600, 600)
  assertEqual(world.moving[w.id], 1, 'worker moving before deselect')
  withFakeDocument(() => {
    ctl.mode = 'move'
    ;(input as unknown as { pendingBuilding: unknown }).pendingBuilding = 'farm'
    input.deselect()
  })
  assertEqual(input.getSelected().length, 0, 'selection cleared')
  assertEqual(input.getMode(), 'selection', 'armed mode disarmed')
  assertEqual(input.getPendingBuilding(), null, 'pending building cleared')
  assertEqual(world.moving[w.id], 1, 'no order issued: the move order survives untouched')
})

test('cancel disarms every armed order mode and keeps the selection', () => {
  const { world, input, ctl } = gestureSetup()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(1 / 60)
  ctl.selected = [w.id]
  for (const mode of ['move', 'attack', 'gather', 'patrol'] as const) {
    ctl.mode = mode
    withFakeDocument(() => {
      input.cancelMode()
    })
    assertEqual(input.getMode(), 'selection', `${mode} mode disarmed by Cancel`)
    assertEqual(input.getSelected().length, 1, `selection kept after cancelling ${mode}`)
  }
  // Build placement: the pending building is cleared too. (Fields set
  // directly: setPendingBuilding would take the DOM banner path, which
  // the fake document stub cannot serve — cancelMode is what's tested.)
  ctl.selected = [w.id]
  ctl.mode = 'build'
  ;(input as unknown as { pendingBuilding: unknown }).pendingBuilding = 'farm'
  withFakeDocument(() => {
    input.cancelMode()
  })
  assertEqual(input.getMode(), 'selection', 'build mode disarmed by Cancel')
  assertEqual(input.getPendingBuilding(), null, 'pending building cleared by Cancel')
  assertEqual(input.getSelected().length, 1, 'selection kept after cancelling placement')
  // Plain selection mode: Cancel is a no-op.
  withFakeDocument(() => {
    input.cancelMode()
  })
  assertEqual(input.getMode(), 'selection', 'still plain selection')
  assertEqual(input.getSelected().length, 1, 'selection untouched by no-op Cancel')
})

test('orderStop disarms auto-gather: a stopped worker stays idle', () => {
  const { world } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  // Simulate a mid-gather worker, then Stop it.
  world.harvestKind[workerId] = HARVEST_WOOD
  orderStop(world, workerId)
  assertEqual(world.state[workerId], STATE_IDLE, 'worker idle after Stop')
  assertEqual(world.harvestKind[workerId], HARVEST_OFF, 'Stop disarms auto-gather')
  world.update(1 / 60)
  assertEqual(world.state[workerId], STATE_IDLE, 'worker still idle a tick later (no re-acquire)')
  assertEqual(world.moving[workerId], 0, 'worker not walking anywhere')
})

test('orderStop frees a builder from its construction task', () => {
  const { world } = setup()
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      workerId = id
      break
    }
  }
  // Simulate a worker walking to / working a farm site, then Stop it.
  const hallId = [...world.entities.keys()].find(
    (id) => world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_HALL,
  )!
  world.targetId[workerId] = hallId
  world.state[workerId] = STATE_BUILD
  world.harvestKind[workerId] = HARVEST_WOOD
  orderStop(world, workerId)
  assertEqual(world.state[workerId], STATE_IDLE, 'builder idle after Stop')
  assertEqual(world.targetId[workerId], NO_TARGET, 'construction target released')
  assertEqual(world.harvestKind[workerId], HARVEST_OFF, 'no auto-gather re-acquire after Stop')
  world.update(1 / 60)
  assertEqual(world.state[workerId], STATE_IDLE, 'builder still idle a tick later')
})

suite('playtest fixes v1b: held-worker statues are visible and recoverable')

test('Idle Workers selects statues (and only idle workers)', () => {
  const { world, input } = setup()
  const statue = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.state[statue.id] = STATE_IDLE
  world.harvestKind[statue.id] = HARVEST_OFF
  world.carryAmount[statue.id] = 0
  const gathering = world.spawnUnit('worker', TEAM_PLAYER, 160, 100)
  world.state[gathering.id] = STATE_GATHER
  world.harvestKind[gathering.id] = HARVEST_WOOD
  const walking = world.spawnUnit('worker', TEAM_PLAYER, 220, 100)
  world.state[walking.id] = STATE_MOVE
  world.harvestKind[walking.id] = HARVEST_OFF
  input.selectIdleWorkers()
  const sel = input.getSelected()
  assert(sel.includes(statue.id), 'statue is selected by Idle Workers')
  assert(!sel.includes(gathering.id), 'gathering worker is not idle-selected')
  assert(!sel.includes(walking.id), 'walking worker is not idle-selected')
})

test('marker condition is true exactly for held workers', () => {
  const { world } = setup()
  const mk = (kind: string, x: number) => {
    const u = world.spawnUnit(kind as 'worker' | 'melee', TEAM_PLAYER, x, 100)
    return u.id
  }
  const held = mk('worker', 100)
  world.state[held] = STATE_IDLE
  world.harvestKind[held] = HARVEST_OFF
  world.carryAmount[held] = 0
  assert(isHeldWorker(world, held), 'idle + HARVEST_OFF + empty hands is held')

  const pending = mk('worker', 160)
  world.state[pending] = STATE_IDLE
  world.harvestKind[pending] = HARVEST_WOOD
  world.carryAmount[pending] = 0
  assert(!isHeldWorker(world, pending), 'idle but auto-gather armed is not held')

  const gathering = mk('worker', 220)
  world.state[gathering] = STATE_GATHER
  world.harvestKind[gathering] = HARVEST_WOOD
  assert(!isHeldWorker(world, gathering), 'gathering worker is not held')

  const walking = mk('worker', 280)
  world.state[walking] = STATE_MOVE
  world.harvestKind[walking] = HARVEST_OFF
  assert(!isHeldWorker(world, walking), 'worker still walking to its hold point is not held')

  const carrying = mk('worker', 340)
  world.state[carrying] = STATE_IDLE
  world.harvestKind[carrying] = HARVEST_OFF
  world.carryAmount[carrying] = 5
  assert(!isHeldWorker(world, carrying), 'worker with a load is delivering, not held')

  const soldier = mk('melee', 400)
  world.state[soldier] = STATE_IDLE
  world.harvestKind[soldier] = HARVEST_OFF
  world.carryAmount[soldier] = 0
  assert(!isHeldWorker(world, soldier), 'a soldier is never a held worker')
})

suite('build flow fixes: placement ends the interaction')

/** Private-surface cast for the build-flow tests (modeOrder/tapSelect/etc.). */
interface BuildCtl {
  mode: string
  selected: number[]
  pendingBuilding: unknown
  modeOrder(x: number, z: number): void
  tapSelect(x: number, z: number, now?: number): void
  smartOrder(x: number, z: number): void
}

function findKind(world: ReturnType<typeof makeWorld>, kind: number, team: number): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind && world.team[id] === team) return id
  }
  return -1
}

test('placing a building ends the interaction: selection cleared, mode disarmed, worker builds', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(STEP)
  bctl.selected = [w.id]
  bctl.mode = 'build'
  bctl.pendingBuilding = 'farm'
  withFakeDocument(() => {
    bctl.modeOrder(112, 100)
  })
  const site = findKind(world, KIND_FARM, TEAM_PLAYER)
  assert(site !== -1, 'the farm was placed')
  assertEqual(input.getSelected().length, 0, 'selection cleared on placement — no farm stays selected')
  assertEqual(input.getMode(), 'selection', 'build mode disarmed on placement')
  assertEqual(input.getPendingBuilding(), null, 'pending building cleared on placement')
  assertEqual(world.state[w.id], STATE_BUILD, 'worker proceeds to construction on its own')
  assertEqual(world.targetId[w.id], site, 'worker targets the placed site')
  stepWorld(world, 60 * 9)
  assert(world.buildProgress[site] >= world.buildTotal[site], 'the lone builder completes the farm')
})

test('deferred placement emits the build command and still ends the interaction', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 100)
  world.update(STEP)
  const emitted: Command[] = []
  input.setCommandListener((c) => emitted.push(c))
  input.setDeferredExecution(true)
  bctl.selected = [w.id]
  bctl.mode = 'build'
  bctl.pendingBuilding = 'farm'
  withFakeDocument(() => {
    bctl.modeOrder(112, 100)
  })
  assertEqual(emitted.length, 1, 'one command emitted')
  assertEqual(emitted[0].type, 'build', 'a build command was emitted')
  assertEqual(findKind(world, KIND_FARM, TEAM_PLAYER), -1, 'deferred: nothing placed locally')
  assertEqual(input.getSelected().length, 0, 'selection cleared')
  assertEqual(input.getMode(), 'selection', 'build mode disarmed')
  assertEqual(input.getPendingBuilding(), null, 'pending building cleared')
})

suite('build flow fixes: multi-builder crews (powerbuild)')

/** Run a crew of `n` parked builders on a fresh farm for `ticks`; return its progress. */
function crewProgress(n: number, ticks: number): number {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed for crew test')
  for (let i = 0; i < n; i += 1) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, 100 + i * 2, 104)
    // Park the builder on the site: assigned, arrived, not walking.
    world.targetId[w.id] = placed.id
    world.state[w.id] = STATE_BUILD
    world.moving[w.id] = 0
    world.harvestKind[w.id] = HARVEST_OFF
  }
  stepWorld(world, ticks)
  return world.buildProgress[placed.id]
}

test('construction crews follow the powerbuild curve 1 + 0.6(n-1), pinned exactly', () => {
  const rate = FACTIONS.human.worker.buildRate // progress per second, lone builder
  const eps = 0.03
  const one = crewProgress(1, 60) // 60 ticks = 1 second
  const two = crewProgress(2, 60)
  const three = crewProgress(3, 60)
  assert(Math.abs(one - rate * 1.0) < eps, `lone builder: ${one} ≈ ${rate} (full rate, unchanged)`)
  assert(Math.abs(two - rate * 1.6) < eps, `two builders: ${two} ≈ ${rate * 1.6} (1 + 0.6)`)
  assert(Math.abs(three - rate * 2.2) < eps, `three builders: ${three} ≈ ${rate * 2.2} (1 + 1.2)`)
})

test('a lone builder completes a farm in the pre-change time and releases to idle', () => {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const w = world.spawnUnit('worker', TEAM_PLAYER, 100, 104)
  world.targetId[w.id] = site
  world.state[w.id] = STATE_BUILD
  world.moving[w.id] = 0
  world.harvestKind[w.id] = HARVEST_OFF
  const capBefore = world.supplyCap[TEAM_PLAYER]
  // Farm total 6 at 1.15/s ≈ 313 ticks: not done at 300, done by 330.
  stepWorld(world, 300)
  assert(world.buildProgress[site] < world.buildTotal[site], 'not complete before the lone-builder time')
  stepWorld(world, 30)
  assert(world.buildProgress[site] >= world.buildTotal[site], 'complete at the lone-builder time (unchanged)')
  assertEqual(world.state[w.id], STATE_IDLE, 'builder released to idle on completion')
  assertEqual(world.supplyCap[TEAM_PLAYER], capBefore + 6, 'farm supply granted exactly once')
})

test('two builders finish faster than one, both release, supply granted once', () => {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const crew: number[] = []
  for (let i = 0; i < 2; i += 1) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, 100 + i * 2, 104)
    world.targetId[w.id] = site
    world.state[w.id] = STATE_BUILD
    world.moving[w.id] = 0
    world.harvestKind[w.id] = HARVEST_OFF
    crew.push(w.id)
  }
  const capBefore = world.supplyCap[TEAM_PLAYER]
  // Crew rate 1.15 × 1.6 = 1.84/s: 6 progress needs ~196 ticks.
  stepWorld(world, 150)
  assert(world.buildProgress[site] < world.buildTotal[site], 'crew not done implausibly early')
  stepWorld(world, 70)
  assert(world.buildProgress[site] >= world.buildTotal[site], 'crew finished well ahead of a lone builder')
  for (const wid of crew) {
    assertEqual(world.state[wid], STATE_IDLE, 'every builder released on completion')
  }
  assertEqual(world.supplyCap[TEAM_PLAYER], capBefore + 6, 'supply granted once, not once per builder')
})

test('tapping an orphaned 0-progress site with a worker selected re-tasks it; a second tap piles on', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const a = world.spawnUnit('worker', TEAM_PLAYER, 96, 100)
  orderBuild(world, a.id, site)
  orderStop(world, a.id) // the known orphan: builder stopped before any progress
  assertEqual(world.buildProgress[site], 0, 'site orphaned at 0 progress')
  assertEqual(buildersOnSite(world, site), 0, 'no builders on the orphaned site')

  const b = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  world.harvestKind[b.id] = HARVEST_OFF
  world.update(STEP) // rebuild spatial hash
  bctl.selected = [b.id]
  bctl.tapSelect(100, 100, 0) // tap the site itself, screen == world in the mock
  assertEqual(world.state[b.id], STATE_BUILD, 'tapped worker joined the orphaned site')
  assertEqual(world.targetId[b.id], site, 'join targets the orphaned site')
  assertEqual(buildersOnSite(world, site), 1, 'one builder assigned after the tap')

  const c = world.spawnUnit('worker', TEAM_PLAYER, 108, 100)
  world.harvestKind[c.id] = HARVEST_OFF
  world.update(STEP)
  bctl.selected = [c.id]
  bctl.tapSelect(100, 100, 0)
  assertEqual(buildersOnSite(world, site), 2, 'second worker piles onto the same site')
  stepWorld(world, 30)
  assert(world.buildProgress[site] > 0, 'the re-tasked crew is making progress')
})

test('smart order onto an unfinished structure sends workers to build; military escorts by moving', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const w = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  const m = world.spawnUnit('melee', TEAM_PLAYER, 108, 100)
  world.update(STEP)
  bctl.selected = [w.id, m.id]
  bctl.smartOrder(100, 100)
  assertEqual(world.state[w.id], STATE_BUILD, 'worker joins construction instead of idling beside the site')
  assertEqual(world.targetId[w.id], site, 'worker targets the site')
  assertEqual(world.moving[m.id], 1, 'melee unit moves toward the site as escort')
})

test('deferred join emits a siteId build command; the executor resumes even a tower', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const placed = placeStructure(world, TEAM_PLAYER, 'tower', 100, 100)
  assert(placed.ok, 'tower placed')
  const site = placed.id
  const w = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  world.harvestKind[w.id] = HARVEST_OFF
  world.update(STEP)
  const emitted: Command[] = []
  input.setCommandListener((c) => emitted.push(c))
  input.setDeferredExecution(true)
  bctl.selected = [w.id]
  bctl.tapSelect(100, 100, 0)
  assertEqual(emitted.length, 1, 'one command emitted for the join')
  const cmd = emitted[0]
  assert(cmd.type === 'build' && cmd.siteId === site, 'join command targets the existing tower site')
  assert(world.targetId[w.id] !== site, 'deferred: the world is not mutated locally')

  // The lockstep executor honors the same command — towers included.
  const world2 = makeWorld()
  const placed2 = placeStructure(world2, TEAM_PLAYER, 'tower', 100, 100)
  assert(placed2.ok, 'tower placed in executor world')
  const w2 = world2.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  applyCommand(world2, { type: 'build', step: 0, workerId: w2.id, building: 'tower', x: 0, z: 0, siteId: placed2.id })
  assertEqual(world2.state[w2.id], STATE_BUILD, 'executor sent the worker to the tower site')
  assertEqual(world2.targetId[w2.id], placed2.id, 'executor join targets the tower')
})

test('unfinished structure card shows builders and progress', () => {
  const { world } = gestureSetup()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  world.buildProgress[site] = world.buildTotal[site] / 2 // 50%
  const w1 = world.spawnUnit('worker', TEAM_PLAYER, 96, 100)
  const w2 = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  orderBuild(world, w1.id, site)
  orderBuild(world, w2.id, site)
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [site], cardCallbacks as never, {})
    const text = collectText(el)
    assert(text.includes('2 builders'), 'card names the assigned crew')
    assert(text.includes('50% built'), 'card shows construction progress')
  })
})

suite('build flow fixes: training progress display')

test('training state reads the sim: fraction and countdown match trainLeft/trainTotal', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  assert(hall !== -1, 'player hall exists')
  assert(enqueueTrain(world, hall, 'worker'), 'worker training started')
  const total = world.trainTotal[hall]
  assert(total > 0, 'train total set by the sim')
  stepWorld(world, 60) // one second in
  const st = trainingStateFor(world, hall)
  assert(st !== null, 'accessor reports active training')
  assertEqual(st!.type, 'worker', 'the training item is the worker')
  assert(
    Math.abs(st!.fraction - (1 - world.trainLeft[hall] / total)) < 1e-6,
    'progress fraction IS the sim ratio, not an estimate',
  )
  assert(Math.abs(st!.secondsLeft - world.trainLeft[hall]) < 1e-6, 'countdown IS trainLeft')
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [hall], cardCallbacks as never, {})
    const text = collectText(el)
    assert(text.includes('Training Peasant'), 'card names the training unit (faction name)')
    assert(text.includes(`${Math.ceil(world.trainLeft[hall])}s left`), 'card shows the seconds remaining')
    let fillWidth = -1
    const walk = (n: FakeEl): void => {
      if (n.className.includes('cmd-trainfill')) fillWidth = parseFloat(n.style.width ?? '-1')
      for (const c of n.children) walk(c)
    }
    walk(el)
    assert(fillWidth >= 0, 'progress bar rendered')
    assert(
      Math.abs(fillWidth - st!.fraction * 100) < 0.6,
      `bar width ${fillWidth}% matches the sim fraction ${(st!.fraction * 100).toFixed(1)}%`,
    )
  })
})

test('training display advances: completion frees the slot and the next unit starts fresh', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  const countWorkers = (): number => {
    let n = 0
    for (const id of world.entities.keys()) {
      if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_PLAYER) n += 1
    }
    return n
  }
  const before = countWorkers()
  assert(enqueueTrain(world, hall, 'worker'), 'first worker training started')
  stepWorld(world, 60 * 6) // worker train time is 5s
  assertEqual(world.trainKind[hall], NO_TRAINING, 'slot freed on completion')
  assertEqual(trainingStateFor(world, hall), null, 'accessor reports no active training')
  assertEqual(countWorkers(), before + 1, 'the trained worker actually spawned')
  assert(enqueueTrain(world, hall, 'worker'), 'next worker training started')
  const st = trainingStateFor(world, hall)
  assert(st !== null && st.fraction < 0.05, 'the next unit starts at the beginning of its bar')
  assertEqual(trainingQueueFor(world, hall).length, 0, 'the next item went straight to the active slot — nothing waiting')
})

test('queue runs collapse duplicates in order, with faction names', () => {
  const { world } = gestureSetup()
  const s = formatQueueRuns(world, TEAM_PLAYER, ['worker', 'worker', 'melee', 'worker'])
  assertEqual(s, 'Peasant ×2 · Footman · Peasant', 'runs collapse with ×N, order preserved')
  assertEqual(formatQueueRuns(world, TEAM_PLAYER, []), '', 'empty queue renders as nothing')
})

suite('approved design calls: production queue — cap 8, tap-to-cancel refunds')

test('the queue accepts 8 items total (1 active + 7 waiting) and refuses the 9th', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  assert(hall !== -1, 'player hall exists')
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  world.supplyCap[TEAM_PLAYER] = 100 // isolate the queue cap from the supply cap
  for (let i = 0; i < 8; i += 1) {
    assert(enqueueTrain(world, hall, 'worker'), `item ${i + 1} of 8 accepted`)
  }
  assertEqual(MAX_TRAIN_QUEUE, 8, 'the approved cap is 8')
  assertEqual(trainQueueCount(world, hall), 8, 'cap reached')
  assertEqual(trainingQueueFor(world, hall).length, 7, 'seven wait behind the active item')
  assert(!enqueueTrain(world, hall, 'worker'), 'the 9th item is refused')
  assertEqual(trainQueueCount(world, hall), 8, 'the refusal changed nothing')
})

test('cancelling a waiting item refunds its full cost and the queue closes ranks', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  assert(enqueueTrain(world, hall, 'worker'), 'active item queued')
  assert(enqueueTrain(world, hall, 'worker'), 'waiting item 1 queued')
  assert(enqueueTrain(world, hall, 'worker'), 'waiting item 2 queued')
  assertEqual(world.gold[TEAM_PLAYER], 850, 'three workers charged at 50g each')
  assertEqual(trainingQueueFor(world, hall).length, 2, 'two waiting')
  assert(cancelTrainQueued(world, hall, 0), 'cancel accepted')
  assertEqual(world.gold[TEAM_PLAYER], 900, 'full 50g refund for the waiting item')
  assertEqual(trainingQueueFor(world, hall).length, 1, 'queue closed ranks')
  assert(!cancelTrainQueued(world, hall, 1), 'index past the end refused')
  assert(!cancelTrainQueued(world, hall, -1), 'negative index refused (active cancels separately)')
  assertEqual(world.gold[TEAM_PLAYER], 900, 'refused cancels refund nothing')
})

test('cancelling the active item refunds it in full and the next item starts fresh', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  assert(enqueueTrain(world, hall, 'worker'), 'first worker training')
  assert(enqueueTrain(world, hall, 'worker'), 'second worker queued')
  const total = world.trainTotal[hall]
  stepWorld(world, 120) // 2s into the 5s train
  assert(world.trainLeft[hall] < total - 1.9, 'active item well underway')
  const goldBefore = world.gold[TEAM_PLAYER]
  assert(cancelTrainActive(world, hall), 'cancel accepted')
  assertEqual(world.gold[TEAM_PLAYER], goldBefore + 50, 'full 50g refund for the active item')
  assertEqual(world.trainKind[hall], KIND_WORKER, 'the queued worker started immediately')
  assertEqual(world.trainLeft[hall], world.trainTotal[hall], 'the next item starts at its full train time')
  assertEqual(trainingQueueFor(world, hall).length, 0, 'queue drained by the promotion')
  assert(cancelTrainActive(world, hall), 'the promoted item can be cancelled too')
  assertEqual(world.trainKind[hall], NO_TRAINING, 'slot empty after the last cancel')
  assert(!cancelTrainActive(world, hall), 'nothing left to cancel')
})

test('a filled queue drains in order: each completion starts the next item', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  const countWorkers = (): number => {
    let n = 0
    for (const id of world.entities.keys()) {
      if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_PLAYER) n += 1
    }
    return n
  }
  const before = countWorkers()
  assert(enqueueTrain(world, hall, 'worker'), 'one')
  assert(enqueueTrain(world, hall, 'worker'), 'two')
  assert(enqueueTrain(world, hall, 'worker'), 'three')
  stepWorld(world, 60 * 5 + 2) // one full train time
  assertEqual(countWorkers(), before + 1, 'first queued worker spawned')
  const st = trainingStateFor(world, hall)
  assert(st !== null && st.type === 'worker', 'second item now active')
  assert(st!.fraction < 0.1, 'second item just started')
  assertEqual(trainingQueueFor(world, hall).length, 1, 'one still waiting')
  stepWorld(world, 60 * 5 + 2)
  assertEqual(countWorkers(), before + 2, 'second spawned')
  stepWorld(world, 60 * 5 + 2)
  assertEqual(countWorkers(), before + 3, 'third spawned')
  assertEqual(trainingStateFor(world, hall), null, 'queue fully drained')
})

test('training card renders tappable cancel targets: active button + collapsed queue chips', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 10000
  assert(enqueueTrain(world, hall, 'worker'), 'active')
  assert(enqueueTrain(world, hall, 'worker'), 'waiting 1')
  assert(enqueueTrain(world, hall, 'worker'), 'waiting 2')
  // Click handlers are DOM-bound and can't fire through the fake
  // document; the cancel BEHAVIOR is pinned by the sim tests above.
  // This test pins the render: a cancel button for the active item and
  // one collapsed chip for the two identical waiting workers.
  const cb = { ...cardCallbacks, onCancelTrain: (_i: number) => {} }
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [hall], cb as never, {})
    const text = collectText(el)
    assert(text.includes('Training Peasant'), 'active item labelled')
    assert(text.includes('Queued:'), 'queue labelled')
    assert(text.includes('Peasant ×2'), 'waiting workers collapsed on the chip')
    const chips: FakeEl[] = []
    let activeBtn: FakeEl | null = null
    const walk = (n: FakeEl): void => {
      if (n.className.split(' ').includes('cmd-train-chip')) chips.push(n)
      if (n.className.split(' ').includes('cmd-train-cancel')) activeBtn = n
      for (const c of n.children) walk(c)
    }
    walk(el)
    assert(activeBtn !== null, 'active item renders as a cancel button')
    assertEqual(chips.length, 1, 'one chip for the collapsed run')
    assertEqual(chips[0].textContent, 'Peasant ×2', 'chip label is the collapsed run')
  })
  // Without the callback the same state renders read-only (text row).
  withFakeDocument(() => {
    const el = fakeEl()
    renderCommandCard(el as never, world, [hall], cardCallbacks as never, {})
    assert(collectText(el).includes('Queued: Peasant ×2'), 'read-only queue row still renders')
  })
})

suite('approved design calls: powerbuild surcharge (+15% per extra builder)')

test('each additional builder pays exactly 15% — ceil per resource — and the first is free', () => {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  world.gold[TEAM_PLAYER] = 500
  world.wood[TEAM_PLAYER] = 500
  const a = world.spawnUnit('worker', TEAM_PLAYER, 96, 100)
  const b = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  const c = world.spawnUnit('worker', TEAM_PLAYER, 100, 106)
  assert(orderBuild(world, a.id, site), 'first builder joins')
  assertEqual(world.gold[TEAM_PLAYER], 500, 'first builder free (gold)')
  assertEqual(world.wood[TEAM_PLAYER], 500, 'first builder free (wood)')
  assert(orderBuild(world, b.id, site), 'second builder joins')
  // Farm base cost 50g / 80w: ceil(50 × .15) = 8g, ceil(80 × .15) = 12w.
  assertEqual(world.gold[TEAM_PLAYER], 492, 'second builder paid exactly 8g')
  assertEqual(world.wood[TEAM_PLAYER], 488, 'second builder paid exactly 12w')
  assert(orderBuild(world, c.id, site), 'third builder joins')
  assertEqual(world.gold[TEAM_PLAYER], 484, 'third builder paid another 8g')
  assertEqual(world.wood[TEAM_PLAYER], 476, 'third builder paid another 12w')
  assert(orderBuild(world, b.id, site), 're-issuing the order to the same builder is accepted')
  assertEqual(world.gold[TEAM_PLAYER], 484, 'no double charge for a builder already on the site')
  const amount = buildSurchargeAmount(world, site)
  assertEqual(amount.gold, 8, 'surcharge amount: 8g for a farm')
  assertEqual(amount.wood, 12, 'surcharge amount: 12w for a farm')
  assertEqual(BUILDINGS.farm.cost.gold, 50, 'farm base gold (surcharge basis)')
})

test('an unaffordable join is refused cleanly; an orphaned site re-tasks for free', () => {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const a = world.spawnUnit('worker', TEAM_PLAYER, 96, 100)
  assert(orderBuild(world, a.id, site), 'first builder joins free')
  world.gold[TEAM_PLAYER] = 7 // one gold short of the 8g surcharge
  world.wood[TEAM_PLAYER] = 500
  const b = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  assert(!orderBuild(world, b.id, site), 'join refused when the surcharge is unaffordable')
  assert(world.state[b.id] !== STATE_BUILD, 'refused worker keeps its current orders')
  assertEqual(world.gold[TEAM_PLAYER], 7, 'the refusal charged nothing')
  assertEqual(buildersOnSite(world, site), 1, 'crew unchanged by the refusal')
  // Orphan the site (builder stopped): with nobody on it, the next
  // builder is the FIRST builder again — free even with empty coffers.
  orderStop(world, a.id)
  assertEqual(buildersOnSite(world, site), 0, 'site orphaned')
  world.gold[TEAM_PLAYER] = 0
  world.wood[TEAM_PLAYER] = 0
  assert(orderBuild(world, b.id, site), 'orphaned site re-tasks for free')
  assertEqual(world.state[b.id], STATE_BUILD, 'replacement builder is building')
})

test('paying the surcharge does not change the crew rate: still 1 + 0.6(n-1)', () => {
  const world = makeWorld()
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  for (let i = 0; i < 3; i += 1) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, 100 + i * 2, 104)
    assert(orderBuild(world, w.id, site), 'builder joined through the surcharge path')
    world.moving[w.id] = 0 // parked on the site: pure rate measurement
  }
  stepWorld(world, 60) // one second of crew work
  const rate = FACTIONS.human.worker.buildRate
  assert(
    Math.abs(world.buildProgress[site] - rate * 2.2) < 0.03,
    `crew progress ${world.buildProgress[site]} ≈ ${rate * 2.2} (powerbuild 1 + 0.6·2)`,
  )
})

test('the tap path refuses an unaffordable join too (no silent assignment)', () => {
  const { world, input } = gestureSetup()
  const bctl = input as unknown as BuildCtl
  const placed = placeStructure(world, TEAM_PLAYER, 'farm', 100, 100)
  assert(placed.ok, 'farm placed')
  const site = placed.id
  const a = world.spawnUnit('worker', TEAM_PLAYER, 96, 100)
  assert(orderBuild(world, a.id, site), 'first builder on site')
  world.gold[TEAM_PLAYER] = 0
  world.wood[TEAM_PLAYER] = 0
  const b = world.spawnUnit('worker', TEAM_PLAYER, 104, 100)
  world.harvestKind[b.id] = HARVEST_OFF
  world.update(STEP)
  bctl.selected = [b.id]
  bctl.tapSelect(100, 100, 0)
  assert(world.state[b.id] !== STATE_BUILD, 'unaffordable tap-join refused')
  assertEqual(buildersOnSite(world, site), 1, 'crew unchanged')
})

suite('fix D supply accounting: queued units count against the cap')

test('in-production units are committed supply: the queue cannot promise past the cap', () => {
  const { world } = gestureSetup()
  const hall = findKind(world, KIND_HALL, TEAM_PLAYER)
  assert(hall !== -1, 'player hall exists')
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  const used = world.supplyUsed[TEAM_PLAYER]
  const cap = world.supplyCap[TEAM_PLAYER]
  const room = cap - used
  assert(room >= 2, `scenario leaves supply room (used ${used}/${cap})`)
  assertEqual(productionCommittedSupply(world, TEAM_PLAYER), 0, 'nothing committed yet')
  for (let i = 0; i < room; i += 1) {
    assert(enqueueTrain(world, hall, 'worker'), `item ${i + 1} fits the cap`)
  }
  assertEqual(world.supplyUsed[TEAM_PLAYER], used, 'nothing has spawned — supplyUsed is unchanged')
  assertEqual(
    productionCommittedSupply(world, TEAM_PLAYER),
    room,
    'every queued worker is committed supply',
  )
  assert(
    !enqueueTrain(world, hall, 'worker'),
    'the next item is refused: used + committed + 1 would pass the cap',
  )
  // Cancelling a waiting item frees its commitment for a new item.
  assert(cancelTrainQueued(world, hall, 0), 'cancel a waiting item')
  assertEqual(productionCommittedSupply(world, TEAM_PLAYER), room - 1, 'commitment freed')
  assert(enqueueTrain(world, hall, 'worker'), 'the freed slot can be queued again')
})
