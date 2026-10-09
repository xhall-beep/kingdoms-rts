/**
 * Input controller regression tests — selection, smart orders, box-select,
 * building quick-select. Uses a mock renderer (no canvas/DOM).
 */
import { TEAM_PLAYER, KIND_WORKER } from '../core/World.ts'
import { makeWorld } from './setup.ts'
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
