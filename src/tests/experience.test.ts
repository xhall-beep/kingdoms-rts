/**
 * Experience-layer regression tests (2026-10-22 rebuild): the three
 * player-facing failures Montz reported —
 *  1. the How to Play overlay could never be dismissed (CSS pointer-events),
 *  2. command-card Attack/Gather modes silently did the wrong thing
 *     (modeOrder filtered entityAt to the own team: attack could never
 *     target an enemy; gather was fully dead for the slot-1 player
 *     because resource nodes carry team 0),
 *  3. placement feedback lied (ghost hardcoded valid, failures silent).
 * Plus palette guards for the map-readability pass (autumn ground/fog).
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_TREE,
  KIND_WORKER,
  TEAM_ENEMY,
  TEAM_PLAYER,
} from '../core/World.ts'
import type { World } from '../core/World.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { canPlaceStructure, placeStructure } from '../world/construction.ts'
import {
  FOG_EXPLORED_FILL,
  FOG_UNEXPLORED_FILL,
  GROUND_BASE,
  groundTintAt,
  treeColorsAt,
} from '../render/renderer.ts'
import type { Command } from '../session/commands.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

/** Full renderer mock (identity screen<->world) recording order pings. */
function mockRenderer() {
  return {
    selection: [] as number[],
    pings: [] as Array<{ kind: string; x: number; z: number }>,
    setSelection(sel: number[]) {
      this.selection = [...sel]
    },
    setSelectionBox(_box: unknown) {},
    screenToWorld(sx: number, sy: number) {
      return { x: sx, z: sy }
    },
    getZoom() {
      return 1
    },
    pan(_dx: number, _dy: number) {},
    centerOn(_x: number, _z: number) {},
    setGhost(_b: unknown, _x: number, _z: number, _v: boolean) {},
    pingMove(x: number, z: number) {
      this.pings.push({ kind: 'move', x, z })
    },
    pingAttack(x: number, z: number) {
      this.pings.push({ kind: 'attack', x, z })
    },
  }
}

type InputInternals = {
  world: unknown
  renderer: unknown
  selected: number[]
  ghostPos: { x: number; z: number } | null
  modeOrder(sx: number, sy: number): void
}

function setupInput() {
  const world = makeWorld()
  const renderer = mockRenderer()
  const input = new InputControllerImpl()
  const internals = input as unknown as InputInternals
  internals.world = world
  internals.renderer = renderer
  const commands: Command[] = []
  input.setCommandListener((cmd) => commands.push(cmd))
  input.setDeferredExecution(true)
  return { world, renderer, input, internals, commands }
}

function findEntity(world: World, pred: (id: number) => boolean): number {
  for (const id of world.entities.keys()) {
    if (pred(id)) return id
  }
  return -1
}

/** Minimal document stub for the build-mode banner (created on setPendingBuilding). */
function stubDocument(): () => void {
  const g = globalThis as Record<string, unknown>
  const prev = g['document']
  g['document'] = {
    getElementById: () => null,
    createElement: () => ({ style: { cssText: '' }, textContent: '', hidden: false }),
    body: { appendChild: () => undefined },
  }
  return () => {
    if (prev === undefined) delete g['document']
    else g['document'] = prev
  }
}

suite('experience: command-card modes')

test('attack mode targets the tapped enemy (was: always attack-move)', () => {
  const restore = stubDocument()
  try {
    const { world, input, internals, commands } = setupInput()
    const mine = world.spawnUnit('melee', TEAM_PLAYER, 0, -10).id
    const foe = world.spawnUnit('melee', TEAM_ENEMY, 0, 10).id
    stepWorld(world, 1) // spatial hash populates on tick (as in the live game)
    internals.selected = [mine]
    input.setMode('attack')
    internals.modeOrder(world.positionX[foe], world.positionZ[foe])
    const atk = commands.find((c) => c.type === 'attack')
    assert(atk !== undefined, 'an attack command was emitted')
    assertEqual(atk?.targetId, foe, 'attack targets the tapped enemy')
    assert(!commands.some((c) => c.type === 'attackmove'), 'did not degrade to attack-move')
  } finally {
    restore()
  }
})

test('gather mode works for the slot-1 player (nodes carry team 0)', () => {
  const restore = stubDocument()
  try {
    const { world, input, internals, commands } = setupInput()
    input.setLocalTeam(TEAM_ENEMY as 1)
    const worker = findEntity(world, (id) => world.team[id] === TEAM_ENEMY && world.kind[id] === KIND_WORKER)
    const tree = findEntity(world, (id) => world.kind[id] === KIND_TREE)
    assert(worker !== -1 && tree !== -1, 'scenario has an enemy worker and a tree')
    stepWorld(world, 1) // spatial hash populates on tick (as in the live game)
    internals.selected = [worker]
    input.setMode('gather')
    internals.modeOrder(world.positionX[tree], world.positionZ[tree])
    const g = commands.find((c) => c.type === 'gather')
    assert(g !== undefined, 'a gather command was emitted')
    assertEqual(g?.nodeId, tree, 'gather targets the tapped tree')
  } finally {
    restore()
  }
})

test('gather mode on empty ground: no command, mode kept (tap acknowledged)', () => {
  const restore = stubDocument()
  try {
    const { world, input, internals, commands } = setupInput()
    const worker = findEntity(world, (id) => world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER)
    internals.selected = [worker]
    input.setMode('gather')
    internals.modeOrder(0, 85) // far from every entity
    assert(!commands.some((c) => c.type === 'gather'), 'no gather command for bare ground')
    assertEqual(input.getMode(), 'gather', 'stays in gather mode for the next tap')
  } finally {
    restore()
  }
})

suite('experience: placement honesty')

test('canPlaceStructure mirrors placeStructure exactly', () => {
  const free = { x: 0, z: 85 }
  const a = makeWorld()
  assert(canPlaceStructure(a, TEAM_PLAYER, 'farm', free.x, free.z), 'free + affordable: can place')
  const b = makeWorld()
  assert(placeStructure(b, TEAM_PLAYER, 'farm', free.x, free.z).ok, 'placeStructure agrees')
  const hall = findEntity(a, (id) => id >= 0 && a.kind[id] === KIND_HALL && a.team[id] === TEAM_PLAYER)
  assert(!canPlaceStructure(a, TEAM_PLAYER, 'farm', a.positionX[hall], a.positionZ[hall]), 'occupied footprint: cannot place')
  const u = makeWorld()
  u.factionOfTeam[TEAM_PLAYER] = 'undead'
  assert(!canPlaceStructure(u, TEAM_PLAYER, 'farm', free.x, free.z), 'undead raise no farms')
  assert(!placeStructure(u, TEAM_PLAYER, 'farm', free.x, free.z).ok, 'placeStructure agrees (undead)')
  const broke = makeWorld()
  broke.wood[TEAM_PLAYER] = 0
  assert(!canPlaceStructure(broke, TEAM_PLAYER, 'farm', free.x, free.z), 'cannot afford: cannot place')
})

test('ghost validity follows footprint and funds', () => {
  const restore = stubDocument()
  try {
    const { world, input, internals } = setupInput()
    input.setPendingBuilding('farm')
    internals.ghostPos = { x: 0, z: 85 }
    assert(input.isGhostValid(world), 'free spot with funds: ghost valid')
    const hall = findEntity(world, (id) => world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER)
    internals.ghostPos = { x: world.positionX[hall], z: world.positionZ[hall] }
    assert(!input.isGhostValid(world), 'on top of the hall: ghost invalid')
    internals.ghostPos = { x: 0, z: 85 }
    world.wood[TEAM_PLAYER] = 0
    assert(!input.isGhostValid(world), 'out of wood: ghost invalid')
  } finally {
    restore()
  }
})

suite('experience: map palette')

test('ground tints are stable, varied, and from the autumn palette', () => {
  assertEqual(groundTintAt(3, 4), groundTintAt(3, 4), 'same cell, same tint (no flicker)')
  const palette = new Set([GROUND_BASE, '#55622f', '#434e24', '#5a6533', '#6b5c2b'])
  const seen = new Set<string>()
  for (let x = -15; x <= 15; x += 1) {
    for (let z = -15; z <= 15; z += 1) {
      const t = groundTintAt(x, z)
      assert(palette.has(t), `tint ${t} is in the autumn palette`)
      seen.add(t)
    }
  }
  assert(seen.size >= 3, `ground has visible variation (${seen.size} tints)`)
  assert(String(GROUND_BASE) !== '#16241a', 'the old near-black ground fill is gone')
})

test('tree canopies are autumn colors, stable per tree', () => {
  const outers = new Set(['#b45f1d', '#c97a24', '#a34d1a', '#8f6b1f'])
  const a = treeColorsAt(-58, -24)
  const b = treeColorsAt(-58, -24)
  assertEqual(a.outer, b.outer, 'same tree, same canopy (no flicker)')
  assert(outers.has(a.outer), 'canopy is an autumn tone, not grass green')
})

test('explored fog dims terrain instead of voiding it', () => {
  assert(String(FOG_EXPLORED_FILL) !== String(FOG_UNEXPLORED_FILL), 'explored and unexplored fog differ')
  const m = /rgba\(\d+,\d+,\d+,([0-9.]+)\)/.exec(FOG_EXPLORED_FILL)
  assert(m !== null, 'explored fog is a translucent fill')
  const alpha = Number(m?.[1])
  assert(alpha > 0 && alpha < 0.45, `explored alpha ${alpha} is lighter than the old 0.45 void`)
})

suite('experience: How to Play wall')

function readRepoFile(rel: string): string {
  const candidates = [rel, fileURLToPath(new URL('../../' + rel, import.meta.url))]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  throw new Error(`cannot locate ${rel}`)
}

test('tutorial overlay can actually receive taps (pointer-events regression)', () => {
  const cssText = readRepoFile('src/style.css')
  const root = /\.hud-tutorial\{([^}]*)\}/.exec(cssText)
  assert(root !== null, '.hud-tutorial rule exists')
  assert(
    /pointer-events\s*:\s*auto/.test(root?.[1] ?? ''),
    '.hud-tutorial opts back into pointer events (its parent #hud-root has none)',
  )
  const hud = readRepoFile('src/ui/hud.ts')
  assert(hud.includes('id="hud-help"'), 'a Help button can reopen the overlay on demand')
  assert(hud.includes('id="hud-tutorial-x"'), 'the overlay has a ✕ dismiss affordance')
  assert(hud.includes('id="hud-tutorial-backdrop"'), 'a backdrop gives tap-outside dismissal')
  assert(!hud.includes('krts-tutorial-seen'), 'no seen-flag auto-show gate remains (on-demand only)')
})

test('goldmine kind is part of the world (sanity for gather tests)', () => {
  const world = makeWorld()
  const mine = findEntity(world, (id) => world.kind[id] === KIND_GOLDMINE)
  assert(mine !== -1, 'scenario seeds gold mines')
  void KIND_MELEE
})
