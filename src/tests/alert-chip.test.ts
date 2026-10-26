/**
 * Event alert chip (feel research 2026-10-26, Q4): the sim pushes
 * visual-only alert events (own unit/building struck, treant spawn,
 * completion), and the HUD raises ONE tap-to-jump chip for
 * OFF-SCREEN events only — per-class cooldown, priority
 * attack > treant > complete. The channel must never enter the
 * lockstep hash (the completionFlashes precedent).
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_HALL } from '../core/World.ts'
import { ATTACK_ALERT_COOLDOWN_TICKS } from '../core/World.ts'
import { hashWorldState } from '../net/hash.ts'
import { WILD_HEAT_THRESHOLD } from '../systems/living-wild.ts'
import { enqueueTrain } from '../systems/production.ts'
import { Renderer } from '../render/renderer.ts'
import {
  HudImpl,
  pickAlert,
  ALERT_COOLDOWN_TICKS,
  ALERT_EXPIRE_TICKS,
} from '../ui/hud.ts'
import type { AlertEvent, AlertKind } from '../core/World.ts'
import type { HudCallbacks } from '../ui/hud.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

// ---------------------------------------------------------------------------
// Push sites — the sim fills the channel
// ---------------------------------------------------------------------------

suite('alert chip: push sites')

test('melee strike on an own unit pushes an attack alert for the player team', () => {
  const world = makeWorld()
  const mine = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const foe = world.spawnUnit('melee', TEAM_ENEMY, 1.2, 0)
  world.sight[mine.id] = 50
  world.sight[foe.id] = 50
  world.alertEvents.length = 0
  stepWorld(world, 10)
  const ev = world.alertEvents.find((e) => e.kind === 'attack' && e.team === TEAM_PLAYER)
  assert(ev !== undefined, 'an attack alert for the struck player unit')
  assert(
    Math.abs((ev?.x ?? 999) - world.positionX[mine.id]) < 2 &&
      Math.abs((ev?.z ?? 999) - world.positionZ[mine.id]) < 2,
    'alert position captured at the struck unit',
  )
})

test('enemy unit struck by a tower pushes nothing for the player', () => {
  const world = makeWorld()
  world.spawnBuilding('tower', TEAM_PLAYER, 0, 0, true)
  const enemy = world.spawnUnit('melee', TEAM_ENEMY, 8, 0)
  // Frozen beyond melee reach (2.1 + tower radius 2.5) but inside
  // tower range (14): it can be struck but can never strike back, so
  // every alert this fight raises belongs to the enemy team.
  world.moveSpeed[enemy.id] = 0
  world.alertEvents.length = 0
  stepWorld(world, 10)
  assert(world.alertEvents.length > 0, 'the tower strike raised an alert')
  assert(
    world.alertEvents.every((e) => e.team === TEAM_ENEMY && e.kind === 'attack'),
    'all alerts concern the enemy team — none for the player',
  )
})

test('treant spawn pushes a treant alert at the harvest site for the offending team', () => {
  const world = makeWorld()
  world.wildSiteX[TEAM_PLAYER] = 12
  world.wildSiteZ[TEAM_PLAYER] = -8
  world.wildHeat[TEAM_PLAYER] = WILD_HEAT_THRESHOLD + 10
  world.alertEvents.length = 0
  stepWorld(world, 1)
  const ev = world.alertEvents.find((e) => e.kind === 'treant')
  assert(ev !== undefined, 'a treant alert was pushed')
  assertEqual(ev?.team, TEAM_PLAYER, 'the alert concerns the harvesting team')
  assertEqual(ev?.x, 12, 'alert x is the harvest site')
  assertEqual(ev?.z, -8, 'alert z is the harvest site')
})

test('training completion pushes a complete alert at the building', () => {
  const world = makeWorld()
  let hall = -1
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER) hall = id
  }
  assert(hall >= 0, 'scenario seeds a player hall')
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  world.supplyCap[TEAM_PLAYER] = 100
  assert(enqueueTrain(world, hall, 'worker'), 'worker queued')
  world.alertEvents.length = 0
  stepWorld(world, 600) // worker trains in 8 s = 480 steps
  const ev = world.alertEvents.find((e) => e.kind === 'complete' && e.team === TEAM_PLAYER)
  assert(ev !== undefined, 'a complete alert was pushed on training completion')
  assert(
    Math.abs((ev?.x ?? 999) - world.positionX[hall]) < 0.01 &&
      Math.abs((ev?.z ?? 999) - world.positionZ[hall]) < 0.01,
    'complete alert sits at the training building',
  )
})

test('attack alerts are throttled at the source: one per team per cooldown', () => {
  const world = makeWorld()
  const a = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const b = world.spawnUnit('melee', TEAM_ENEMY, 1.2, 0)
  // A long duel: neither side can die inside the test window.
  for (const u of [a, b]) {
    world.health[u.id] = 100000
    world.maxHealth[u.id] = 100000
    world.sight[u.id] = 50
  }
  world.alertEvents.length = 0
  stepWorld(world, 300) // 5 s of continuous trading
  const first = world.alertEvents.filter((e) => e.kind === 'attack' && e.team === TEAM_PLAYER)
  assertEqual(first.length, 1, 'a sustained fight raises exactly one attack alert per cooldown window')
  stepWorld(world, 400) // past the 600-tick cooldown from the first strike
  const all = world.alertEvents.filter((e) => e.kind === 'attack' && e.team === TEAM_PLAYER)
  assertEqual(all.length, 2, 'a second alert is allowed once the cooldown lapses')
  assert(
    (all[1]?.tick ?? 0) - (all[0]?.tick ?? 0) >= ATTACK_ALERT_COOLDOWN_TICKS,
    'source alerts are spaced by at least the cooldown',
  )
})

test('alert channel is visual-only: a populated queue never moves the hash', () => {
  const world = makeWorld()
  const before = hashWorldState(world)
  world.pushAlert('attack', 10, 20, TEAM_PLAYER)
  world.pushAlert('treant', -30, 5, TEAM_ENEMY)
  world.pushAlert('complete', 0, 0, TEAM_PLAYER)
  world.lastAttackAlertTick[TEAM_PLAYER] = world.tick
  assert(hashWorldState(world) === before, 'alert events + throttle stamp must not affect the lockstep hash')
  assertEqual(world.alertEvents.length, 3, 'the events are queued for the HUD')
})

// ---------------------------------------------------------------------------
// pickAlert — the display gate (pure)
// ---------------------------------------------------------------------------

suite('alert chip: pickAlert gate')

const NO_COOLDOWN: Record<AlertKind, number> = {
  attack: -1000000,
  treant: -1000000,
  complete: -1000000,
}
const offScreen = (): boolean => false
const ev = (kind: AlertKind, team: 0 | 1, x = 50, z = 50): AlertEvent => ({ kind, x, z, team, tick: 0 })

test('enemy-team events never pick for the player', () => {
  const picked = pickAlert([ev('attack', TEAM_ENEMY)], TEAM_PLAYER, null, NO_COOLDOWN, 0, offScreen)
  assertEqual(picked, null, 'an enemy attack alert is not the player\u2019s chip')
})

test('on-screen events raise no chip; off-screen events do', () => {
  const atCenter = ev('attack', TEAM_PLAYER, 0, 0)
  const onScreen = (x: number, z: number): boolean => x === 0 && z === 0
  assertEqual(
    pickAlert([atCenter], TEAM_PLAYER, null, NO_COOLDOWN, 0, onScreen),
    null,
    'event at the camera centre is already visible — no chip',
  )
  const far = ev('attack', TEAM_PLAYER, 60, 60)
  assertEqual(
    pickAlert([far], TEAM_PLAYER, null, NO_COOLDOWN, 0, onScreen),
    far,
    'far off-screen event raises the chip',
  )
  const mixed = pickAlert([atCenter, far], TEAM_PLAYER, null, NO_COOLDOWN, 0, onScreen)
  assertEqual(mixed, far, 'the off-screen candidate wins over the visible one')
})

test('display cooldown suppresses a class until it lapses', () => {
  const shown = { ...NO_COOLDOWN, attack: 0 }
  assertEqual(
    pickAlert([ev('attack', TEAM_PLAYER)], TEAM_PLAYER, null, shown, ALERT_COOLDOWN_TICKS - 1, offScreen),
    null,
    'one tick before the cooldown lapses: still suppressed',
  )
  const late = ev('attack', TEAM_PLAYER)
  assertEqual(
    pickAlert([late], TEAM_PLAYER, null, shown, ALERT_COOLDOWN_TICKS, offScreen),
    late,
    'at the cooldown boundary the class may chip again',
  )
  // Other classes are unaffected by the attack cooldown.
  const treant = ev('treant', TEAM_PLAYER)
  assertEqual(
    pickAlert([treant], TEAM_PLAYER, null, shown, 10, offScreen),
    treant,
    'cooldowns are per-class',
  )
})

test('priority: attack beats treant beats complete; preemption is one-way', () => {
  const complete = ev('complete', TEAM_PLAYER)
  const treant = ev('treant', TEAM_PLAYER)
  const attack = ev('attack', TEAM_PLAYER)
  assertEqual(
    pickAlert([complete, treant, attack], TEAM_PLAYER, null, NO_COOLDOWN, 0, offScreen),
    attack,
    'highest priority wins the empty chip',
  )
  const showingComplete = { kind: 'complete' as AlertKind, x: 0, z: 0, shownTick: 0 }
  assertEqual(
    pickAlert([attack], TEAM_PLAYER, showingComplete, NO_COOLDOWN, 0, offScreen),
    attack,
    'attack preempts a showing complete chip',
  )
  const showingAttack = { kind: 'attack' as AlertKind, x: 0, z: 0, shownTick: 0 }
  assertEqual(
    pickAlert([complete], TEAM_PLAYER, showingAttack, NO_COOLDOWN, 0, offScreen),
    null,
    'complete never preempts a showing attack chip',
  )
  assertEqual(
    pickAlert([treant], TEAM_PLAYER, showingAttack, NO_COOLDOWN, 0, offScreen),
    null,
    'treant never preempts a showing attack chip',
  )
})

// ---------------------------------------------------------------------------
// Renderer probe — camera truth
// ---------------------------------------------------------------------------

suite('alert chip: renderer on-screen probe')

function makeRenderer(): Renderer {
  const ctx = new Proxy({}, { get: () => () => undefined })
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return new Renderer(canvas as unknown as HTMLCanvasElement)
}

test('isWorldPointOnScreen follows the camera and viewport', () => {
  const renderer = makeRenderer()
  assertEqual(renderer.isWorldPointOnScreen(0, 0), false, 'unmeasured viewport reads as off-screen')
  renderer.resize(412, 915)
  renderer.centerOn(-40, -40, 10)
  assertEqual(renderer.isWorldPointOnScreen(-40, -40), true, 'the camera centre is on screen')
  assertEqual(renderer.isWorldPointOnScreen(60, 60), false, 'the far corner of the world is off screen')
  assertEqual(renderer.isWorldPointOnScreen(-55, -40), true, 'inside the left edge is on screen')
  renderer.centerOn(40, 40, 10)
  assertEqual(renderer.isWorldPointOnScreen(-40, -40), false, 'after the jump, the old centre is off screen')
  assertEqual(renderer.isWorldPointOnScreen(40, 40), true, 'the new centre is on screen')
})

// ---------------------------------------------------------------------------
// HUD wiring — fake DOM (hud-labels-wild pattern)
// ---------------------------------------------------------------------------

suite('alert chip: HUD wiring')

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
  private segs: FakeEl[] | null = null
  classList = {
    add: (...cs: string[]): void => {
      for (const c of cs) this.classes.add(c)
    },
    remove: (...cs: string[]): void => {
      for (const c of cs) this.classes.delete(c)
    },
    contains: (c: string): boolean => this.classes.has(c),
    toggle: (c: string, force?: boolean): void => {
      const on = force === undefined ? !this.classes.has(c) : force
      if (on) this.classes.add(c)
      else this.classes.delete(c)
    },
  }

  addEventListener(type: string, fn: () => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }

  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
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

  querySelectorAll(sel: string): FakeEl[] {
    if (sel === '.hud-wild-seg') {
      if (!this.segs) this.segs = [new FakeEl(), new FakeEl(), new FakeEl(), new FakeEl(), new FakeEl()]
      return this.segs
    }
    return []
  }

  setAttribute(_k: string, _v: string): void {}
  getAttribute(_k: string): string | null {
    return null
  }

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

interface HudRig {
  hud: HudImpl
  alertEl: FakeEl
  jumps: Array<[number, number]>
  world: World
}

function makeRig(): HudRig {
  const parent = new FakeEl()
  for (const sel of ['#hud-menu', '#hud-banner', '#hud-pvp-status', '#hud-tutorial', '#hud-tutorial-backdrop', '#hud-speed', '#hud-surrender', '#hud-alert']) {
    parent.primeHidden(sel)
  }
  const jumps: Array<[number, number]> = []
  const noop = (): void => {}
  const callbacks = {
    onMode: noop,
    onBuildType: noop,
    onTrain: noop,
    onCancelTrain: noop,
    onResearch: noop,
    onSelectBuilding: noop,
    onNewGame: noop,
    onSelectIdleWorkers: noop,
    onLocateBase: noop,
    onAlertJump: (x: number, z: number): void => {
      jumps.push([x, z])
    },
    onStop: noop,
    onHold: noop,
    onGestureMode: noop,
    onDeselect: noop,
    onCancelMode: noop,
    onMilitia: noop,
    onUpgrade: noop,
    onWarHorn: noop,
    onPause: noop,
    onSave: noop,
    onLoad: noop,
    onDifficulty: noop,
    onPersonality: noop,
    onReplay: noop,
    onReplaySpeed: noop,
  } as unknown as HudCallbacks
  const hud = new HudImpl()
  hud.mount(parent as unknown as HTMLElement, callbacks)
  // Camera probe for the rig: only the world origin reads as on screen.
  hud.setAlertViewportProbe((x, z) => x === 0 && z === 0)
  return { hud, alertEl: parent.querySelector('#hud-alert'), jumps, world: makeWorld() }
}

function withRig(fn: (rig: HudRig) => void): void {
  const restoreLs = stubLocalStorage()
  const restoreDoc = stubDocument()
  try {
    fn(makeRig())
  } finally {
    restoreLs()
    restoreDoc()
  }
}

test('off-screen attack shows the chip; an on-screen one does not', () => {
  withRig(({ hud, alertEl, world }) => {
    world.pushAlert('attack', 0, 0, TEAM_PLAYER) // at the camera centre
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'on-screen attack raises no chip')
    world.pushAlert('attack', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'off-screen attack shows the chip')
    assertEqual(alertEl.textContent, '⚔ Under attack!', 'attack chip text')
    assert(alertEl.className.includes('hud-alert-attack'), 'attack chip styling class')
    assertEqual(world.alertEvents.length, 0, 'the HUD drained the alert queue')
  })
})

test('enemy-team events never reach the chip', () => {
  withRig(({ hud, alertEl, world }) => {
    world.pushAlert('attack', 60, 60, TEAM_ENEMY)
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'an enemy alert is not the player\u2019s chip')
  })
})

test('tap jumps the camera to the event and dismisses the chip', () => {
  withRig(({ hud, alertEl, world, jumps }) => {
    world.pushAlert('attack', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'chip showing before the tap')
    alertEl.fire('click')
    assertEqual(jumps.length, 1, 'one jump fired')
    assertEqual(jumps[0]?.[0], 60, 'jump x is the event position')
    assertEqual(jumps[0]?.[1], 60, 'jump z is the event position')
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'chip dismissed after the tap')
  })
})

test('chip auto-expires after its lifetime', () => {
  withRig(({ hud, alertEl, world }) => {
    world.pushAlert('treant', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'treant chip showing')
    assertEqual(alertEl.textContent, '🌲 The wild stirs…', 'treant chip text')
    world.tick += ALERT_EXPIRE_TICKS - 1
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'chip still up one tick before expiry')
    world.tick += 1
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'chip retired at expiry')
  })
})

test('chip retires early when the player pans the event on screen', () => {
  withRig(({ hud, alertEl, world }) => {
    hud.setAlertViewportProbe(() => false)
    world.pushAlert('attack', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'chip showing while the event is off screen')
    hud.setAlertViewportProbe(() => true) // player panned to it
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'chip retires once the event is on screen')
  })
})

test('three attacks inside the cooldown produce one chip', () => {
  withRig(({ hud, alertEl, world }) => {
    world.pushAlert('attack', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'first attack chips')
    world.tick += ALERT_EXPIRE_TICKS // chip expires…
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, '…and retires')
    world.pushAlert('attack', 62, 62, TEAM_PLAYER) // still inside the class cooldown
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'second attack inside the cooldown stays silent')
    world.pushAlert('attack', 64, 64, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, true, 'third attack inside the cooldown stays silent')
    world.tick = ALERT_COOLDOWN_TICKS // cooldown from the show tick (0) lapses
    world.pushAlert('attack', 66, 66, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.hidden, false, 'after the cooldown the class chips again')
  })
})

test('priority preemption through the HUD: attack replaces complete, never the reverse', () => {
  withRig(({ hud, alertEl, world }) => {
    world.pushAlert('complete', 60, 60, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.textContent, '✓ Complete', 'complete chip showing')
    world.pushAlert('attack', 70, 70, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.textContent, '⚔ Under attack!', 'attack preempts the complete chip')
    world.pushAlert('complete', 80, 80, TEAM_PLAYER)
    hud.update(world, [])
    assertEqual(alertEl.textContent, '⚔ Under attack!', 'complete does not preempt back')
  })
})
