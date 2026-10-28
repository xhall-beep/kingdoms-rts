/**
 * HUD per-frame work (perf pass 2026-10-27 follow-up): update() runs
 * every rAF frame, but the strip readouts, unit counts, and building
 * pills all derive from sim state, which moves only on sim ticks.
 * This suite pins the slice that stops the per-frame waste:
 *  - strip textContent writes happen only when the string changes
 *  - the two full entity-set scans (counts + building bar) run at
 *    most once per sim tick per world
 *  - counts still refresh on the very next tick after a change
 *
 * The documented bound: a local command applied between ticks (train
 * taps apply immediately in local play) lands in the cached counts at
 * most one sim tick late, display-only — the selected building's own
 * command card is keyed separately and stays live every frame.
 */
import { suite, test, assertEqual } from './harness.ts'
import { World, TEAM_PLAYER } from '../core/World.ts'
import { HudImpl } from '../ui/hud.ts'
import type { HudCallbacks } from '../ui/hud.ts'
import { makeWorld, stepWorld } from './setup.ts'

// ---------------------------------------------------------------------------
// Fake DOM (alert-chip pattern)
// ---------------------------------------------------------------------------

class FakeEl {
  hidden = false
  textContent = ''
  value = ''
  className = ''
  dataset: Record<string, string> = {}
  style: Record<string, unknown> = {}
  children: FakeEl[] = []
  scrollWidth = 0
  clientWidth = 0
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
  parent: FakeEl
  world: World
}

function makeRig(): HudRig {
  const parent = new FakeEl()
  for (const sel of ['#hud-menu', '#hud-banner', '#hud-pvp-status', '#hud-tutorial', '#hud-tutorial-backdrop', '#hud-speed', '#hud-surrender', '#hud-alert']) {
    parent.primeHidden(sel)
  }
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
    onAlertJump: noop,
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
  return { hud, parent, world: makeWorld() }
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

/** Count textContent assignments on one element (the guard under test). */
function countWrites(el: FakeEl): { writes: () => number } {
  let value = el.textContent
  let writes = 0
  Object.defineProperty(el, 'textContent', {
    get: () => value,
    set: (v: string) => {
      writes += 1
      value = v
    },
    configurable: true,
  })
  return { writes: () => writes }
}

/** A Map that counts keys() iterations (the entity scans under test). */
class CountingMap<K, V> extends Map<K, V> {
  keysCalls = 0
  keys() {
    this.keysCalls += 1
    return super.keys()
  }
}

function workersShown(text: string): number {
  const m = /Workers (\d+)/.exec(text)
  if (m === null) throw new Error(`army text carries a worker count (got ${text})`)
  return Number(m[1])
}

// ---------------------------------------------------------------------------
// Strip write guard
// ---------------------------------------------------------------------------

suite('hud perf: strip writes only on change')

test('gold readout writes once, then stays silent until gold moves', () => {
  withRig(({ hud, parent, world }) => {
    const goldEl = parent.querySelector('#hud-gold')
    const counter = countWrites(goldEl)
    hud.update(world, [])
    assertEqual(counter.writes(), 1, 'first update writes the strip value')
    hud.update(world, [])
    assertEqual(counter.writes(), 1, 'second frame on unchanged sim writes nothing')
    world.gold[TEAM_PLAYER] += 25
    hud.update(world, [])
    assertEqual(counter.writes(), 2, 'a moved value writes exactly once more')
  })
})

// ---------------------------------------------------------------------------
// Once-per-tick scans
// ---------------------------------------------------------------------------

suite('hud perf: entity scans at most once per sim tick')

test('counts + building scans run on the first frame, then not again until the tick moves', () => {
  withRig(({ hud, world }) => {
    const counting = new CountingMap(world.entities)
    ;(world as unknown as { entities: typeof counting }).entities = counting
    counting.keysCalls = 0
    hud.update(world, [])
    assertEqual(counting.keysCalls, 2, 'first frame scans once for counts, once for the building bar')
    counting.keysCalls = 0
    hud.update(world, [])
    assertEqual(counting.keysCalls, 0, 'same-tick frame scans nothing')
    stepWorld(world, 1)
    counting.keysCalls = 0
    hud.update(world, [])
    assertEqual(counting.keysCalls, 2, 'a new tick re-scans once per pass')
  })
})

test('counts refresh on the next tick after a spawn (bound: at most one tick late)', () => {
  withRig(({ hud, parent, world }) => {
    hud.update(world, [])
    const before = workersShown(parent.querySelector('#hud-info-army').textContent)
    world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
    hud.update(world, [])
    assertEqual(
      workersShown(parent.querySelector('#hud-info-army').textContent),
      before,
      'same-tick frame still shows the cached count (the documented bound)',
    )
    stepWorld(world, 1)
    hud.update(world, [])
    assertEqual(
      workersShown(parent.querySelector('#hud-info-army').textContent),
      before + 1,
      'the next tick shows the spawned worker',
    )
  })
})
