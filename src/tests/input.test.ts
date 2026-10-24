/**
 * Input controller regression tests — selection, smart orders, box-select,
 * building quick-select. Uses a mock renderer (no canvas/DOM).
 */
import { TEAM_PLAYER, KIND_HALL, KIND_WORKER } from '../core/World.ts'
import { makeWorld } from './setup.ts'
import { orderMove, orderStop } from '../systems/movement.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { renderCommandCard } from '../ui/command-card.ts'
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
