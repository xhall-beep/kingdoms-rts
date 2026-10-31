/**
 * Basics slice 4 — "The Idle button answers" (Montz's "Improve
 * basics", 2026-10-31; basics audit F8 follow-up).
 *
 * What is pinned here:
 *  - The 👷 Idle Workers tap used to answer a selection of nothing
 *    with nothing: no selection change, no sound, no text. In the
 *    opening — every worker auto-gathering — that reads as a dead
 *    button. Now selectIdleWorkers reports its count, and main.ts
 *    announces NO_IDLE_WORKERS_TEXT in the refusal lane on zero.
 *  - The selection rule itself is unchanged (STATE_IDLE + empty
 *    hands): gathering, walking, and laden-but-idle workers are
 *    still not idle-selected; only the empty-tap answer is new.
 *  - The banner text is pinned exactly: it states the outcome
 *    alone, which holds whether the player has busy workers or
 *    none at all.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  TEAM_PLAYER,
  KIND_WORKER,
  CARRY_GOLD,
  CARRY_NONE,
  STATE_GATHER,
  STATE_IDLE,
  STATE_MOVE,
} from '../core/World.ts'
import { makeWorld } from './setup.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { NO_IDLE_WORKERS_TEXT } from '../ui/hud.ts'

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

function playerWorkers(world: ReturnType<typeof makeWorld>): number[] {
  const ids: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) ids.push(id)
  }
  return ids
}

function readRepoFile(rel: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    `${here}../../${rel}`,
    `${here}../../../${rel}`,
    `/home/hatch/workspace/kingdoms-rts/${rel}`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  throw new Error(`cannot locate ${rel}`)
}

suite('basics slice 4: idle workers answer')

test('seed idle workers are counted and selected', () => {
  const { world, input } = setup()
  const workers = playerWorkers(world)
  assert(workers.length > 0, 'seed has player workers')
  for (const id of workers) {
    assertEqual(world.state[id], STATE_IDLE, 'seed workers start idle')
    assertEqual(world.carryKind[id], CARRY_NONE, 'seed workers carry nothing')
  }
  const n = input.selectIdleWorkers()
  assertEqual(n, workers.length, 'count is the full idle set')
  assertEqual(input.getSelected().length, workers.length, 'selection holds them')
})

test('all-busy world returns zero and selects nothing', () => {
  const { world, input } = setup()
  const workers = playerWorkers(world)
  assert(workers.length > 0, 'seed has player workers')
  // The opening's normal state: everyone gathering, plus one walking
  // and one laden-but-idle to pin both non-idle branches.
  workers.forEach((id, i) => {
    if (i === 0) {
      world.state[id] = STATE_MOVE
    } else if (i === 1) {
      world.state[id] = STATE_IDLE
      world.carryKind[id] = CARRY_GOLD
    } else {
      world.state[id] = STATE_GATHER
    }
  })
  const n = input.selectIdleWorkers()
  assertEqual(n, 0, 'no idle worker, count zero')
  assertEqual(input.getSelected().length, 0, 'selection emptied, not stale')
})

test('one idle worker among busy ones is counted and selected alone', () => {
  const { world, input } = setup()
  const workers = playerWorkers(world)
  assert(workers.length >= 2, 'need at least two seed workers')
  for (const id of workers) world.state[id] = STATE_GATHER
  world.state[workers[0]] = STATE_IDLE
  world.carryKind[workers[0]] = CARRY_NONE
  const n = input.selectIdleWorkers()
  assertEqual(n, 1, 'exactly the idle one counts')
  const sel = input.getSelected()
  assertEqual(sel.length, 1, 'exactly one selected')
  assert(sel[0] === workers[0], 'the selected one is the idle worker')
})

test('banner text is the exact shipped copy', () => {
  assertEqual(NO_IDLE_WORKERS_TEXT, 'No idle workers', 'pinned copy')
})

test('main.ts wires the empty idle tap to the refusal lane', () => {
  const main = readRepoFile('src/main.ts')
  assert(
    main.includes('onSelectIdleWorkers'),
    'the idle callback exists',
  )
  assert(
    main.includes('selectIdleWorkers()') &&
      main.includes('announceRefusal(NO_IDLE_WORKERS_TEXT)'),
    'a zero count announces the idle text — deleting it returns the tap to silence',
  )
})
