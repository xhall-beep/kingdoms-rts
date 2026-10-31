/**
 * Basics slice 2 — "Opening direction + honest refusals" (Montz's
 * "Improve basics", 2026-10-31; basics audit items F1/F2/F5/F9).
 *
 * What is pinned here:
 *  - The refusal predicates in production.ts ARE the commands' guard
 *    chains: for every staged state, (predicate === null) must equal
 *    (command applies), and the named reasons must be the audit's
 *    measured ones — supply on the 7th worker at the Hall with gold
 *    plentiful, queue-full on the 9th with supply raised, the exact
 *    gold shortfall, the Archery gate.
 *  - The HUD: local play gets a match-start banner through the lease
 *    (and silence without one — the pre-slice behaviour), a refusal
 *    banner carries its text under the error class, the First Bell
 *    explains itself, and Help no longer sends the player to a menu
 *    that contains no build/train controls.
 *  - The card: build entries show purpose / shortfall / lock on the
 *    note line; a supply-blocked train button stays LIVE with
 *    'Supply full' on its note (its tap is what surfaces the banner),
 *    while a gold-blocked one disables with the missing amount.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual } from './harness.ts'
import { World, TEAM_PLAYER, KIND_HALL, KIND_WORKER } from '../core/World.ts'
import { makeWorld } from './setup.ts'
import {
  enqueueTrain,
  researchRefusal,
  researchUpgrade,
  trainCostFor,
  trainRefusal,
  upgradeBuilding,
  upgradeRefusal,
} from '../systems/production.ts'
import { UPGRADES } from '../data/upgrades.ts'
import { HudImpl, OPENING_BANNER_TEXT } from '../ui/hud.ts'
import { renderCommandCard } from '../ui/command-card.ts'

function findEntity(world: World, kind: number, team: number): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind && world.team[id] === team) return id
  }
  throw new Error(`entity kind ${kind} team ${team} not found`)
}

// File access for the startup-wiring pin (same resolution pattern as
// experience-fixes.test.ts): the opening banner is a main.ts call, not
// HUD behaviour, so no fake-DOM rig can reach it — pin the call site.
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

// ---------------------------------------------------------------------------
// Refusal predicates = the commands' own guards
// ---------------------------------------------------------------------------

suite('basics slice 2: train refusals name the sim reason')

test('gold shortfall: exact missing amount, enqueue agrees', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  const cost = trainCostFor(world, TEAM_PLAYER, 'worker')
  world.gold[TEAM_PLAYER] = cost.gold - 10
  world.wood[TEAM_PLAYER] = 1000
  const refusal = trainRefusal(world, hall, 'worker')
  assertEqual(refusal?.kind, 'gold', 'refusal kind')
  assertEqual(refusal?.kind === 'gold' ? refusal.short : -1, 10, 'shortfall amount')
  assertEqual(enqueueTrain(world, hall, 'worker'), false, 'enqueueTrain refuses identically')
})

test('supply: the 7th worker at the Hall refuses on supply (audit staging)', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  const results: boolean[] = []
  for (let i = 0; i < 7; i += 1) {
    // Predicate first (pure), then the command — they must agree.
    const refusal = trainRefusal(world, hall, 'worker')
    const ok = enqueueTrain(world, hall, 'worker')
    assertEqual(refusal === null, ok, `attempt ${i + 1}: predicate and command agree`)
    results.push(ok)
  }
  assertEqual(results.join(','), 'true,true,true,true,true,true,false', 'six queue, seventh refused')
  assertEqual(trainRefusal(world, hall, 'worker')?.kind, 'supply', 'the seventh refusal is supply')
})

test('queue cap: the 9th refuses queue-full once supply is raised', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  world.supplyCap[TEAM_PLAYER] = 999
  for (let i = 0; i < 8; i += 1) {
    assertEqual(enqueueTrain(world, hall, 'worker'), true, `enqueue ${i + 1} applies`)
  }
  assertEqual(trainRefusal(world, hall, 'worker')?.kind, 'queue-full', 'ninth refusal is the queue cap')
  assertEqual(enqueueTrain(world, hall, 'worker'), false, 'enqueueTrain refuses identically')
})

test('archery gate: ranged at the Barracks refuses needs-archery, melee applies', () => {
  const world = makeWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, -20, -40, true).id
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  assertEqual(trainRefusal(world, barracks, 'ranged')?.kind, 'needs-archery', 'ranged gated')
  assertEqual(enqueueTrain(world, barracks, 'ranged'), false, 'enqueueTrain refuses identically')
  assertEqual(trainRefusal(world, barracks, 'melee'), null, 'melee has no refusal')
  assertEqual(enqueueTrain(world, barracks, 'melee'), true, 'melee applies')
})

test('unfinished building: refuses unfinished', () => {
  const world = makeWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, -20, -40, false).id
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  assertEqual(trainRefusal(world, barracks, 'melee')?.kind, 'unfinished', 'under construction')
  assertEqual(enqueueTrain(world, barracks, 'melee'), false, 'enqueueTrain refuses identically')
})

suite('basics slice 2: research + upgrade refusals')

test('research: gold shortfall names researchCost, max level names max-level', () => {
  const world = makeWorld()
  const smithy = world.spawnBuilding('smithy', TEAM_PLAYER, -24, -40, true).id
  world.gold[TEAM_PLAYER] = 0
  world.wood[TEAM_PLAYER] = 1000
  const refusal = researchRefusal(world, smithy, 'meleeDmg')
  assertEqual(refusal?.kind, 'gold', 'refusal kind')
  assertEqual(refusal?.kind === 'gold' ? refusal.short : -1, 80, 'human Adaptable price is the shortfall base')
  assertEqual(researchUpgrade(world, smithy, 'meleeDmg'), false, 'researchUpgrade refuses identically')

  world.gold[TEAM_PLAYER] = 10000
  world.meleeDmgLvl[TEAM_PLAYER] = UPGRADES.meleeDmg.maxLevel
  assertEqual(researchRefusal(world, smithy, 'meleeDmg')?.kind, 'max-level', 'maxed ladder')
  assertEqual(researchUpgrade(world, smithy, 'meleeDmg'), false, 'researchUpgrade refuses identically')
})

test('tier upgrade: orc hall with empty treasury refuses on gold', () => {
  const world = makeWorld()
  const orcHall = findEntity(world, KIND_HALL, 1)
  world.gold[1] = 0
  world.wood[1] = 1000
  const refusal = upgradeRefusal(world, orcHall)
  assertEqual(refusal?.kind, 'gold', 'refusal kind')
  assertEqual(upgradeBuilding(world, orcHall), false, 'upgradeBuilding refuses identically')
  world.gold[1] = 10000
  assertEqual(upgradeRefusal(world, orcHall), null, 'funded upgrade has no refusal')
  assertEqual(upgradeBuilding(world, orcHall), true, 'funded upgrade applies')
})

// ---------------------------------------------------------------------------
// HUD: opening banner, refusal banner, First Bell, Help truth
// (fake-DOM rig — hud-perf / hud-labels pattern)
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
  banner: FakeEl
}

function makeHudRig(): HudRig {
  const parent = new FakeEl()
  for (const sel of ['#hud-menu', '#hud-banner', '#hud-pvp-status', '#hud-tutorial', '#hud-tutorial-backdrop', '#hud-speed', '#hud-surrender', '#hud-alert']) {
    parent.primeHidden(sel)
  }
  const hud = new HudImpl()
  hud.mount(parent as unknown as HTMLElement)
  return { hud, parent, banner: parent.querySelector('#hud-banner') }
}

function withHudRig(fn: (rig: HudRig) => void): void {
  const restoreLs = stubLocalStorage()
  const restoreDoc = stubDocument()
  try {
    fn(makeHudRig())
  } finally {
    restoreLs()
    restoreDoc()
  }
}

suite('basics slice 2: HUD banners + Help')

test('no announcement, no banner: silence is the default (pre-slice behaviour)', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    hud.update(world, [])
    assertEqual(banner.hidden, true, 'banner stays hidden without an announcement')
  })
})

test('match-start banner fires with the shipped opening line and survives update', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    hud.announceOpening()
    assertEqual(banner.hidden, false, 'banner visible at match start')
    assertEqual(banner.textContent, OPENING_BANNER_TEXT, 'opening copy')
    assert(banner.className.includes('hud-banner-note'), 'note class (fits the line at 412px)')
    hud.update(world, [])
    assertEqual(banner.hidden, false, 'lease holds the banner through update (no write-then-hide)')
    assertEqual(banner.textContent, OPENING_BANNER_TEXT, 'copy survives update')
  })
})

test('refusal banner carries its reason under the error class', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    hud.announceRefusal('Supply full — build a Farm')
    assertEqual(banner.hidden, false, 'banner visible')
    assertEqual(banner.textContent, 'Supply full — build a Farm', 'reason text')
    assert(banner.className.includes('hud-banner-error'), 'error class')
    hud.update(world, [])
    assertEqual(banner.hidden, false, 'lease holds the refusal through update')
  })
})

test('First Bell banner explains itself', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    world.bellsRung[0] = 1
    hud.update(world, [])
    assertEqual(banner.hidden, false, 'bell banner visible')
    assert(banner.textContent.includes('First Bell'), 'names the bell')
    assert(banner.textContent.includes('first probe'), 'says what it means')
  })
})

test('First Bell banner renders the exact shipped line, whole', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    world.bellsRung[0] = 1
    hud.update(world, [])
    // Exact copy pin: at 180s no personality can have advanced yet (the
    // pacing floor is 225s/240s), so the line announces the probe as
    // coming — claiming it launches here would be false on screen.
    assertEqual(
      banner.textContent,
      "🔔 First Bell — the Raid Bell: the enemy's first probe is coming",
      'exact First Bell copy (true at 180s for every personality)',
    )
    assert(banner.className.includes('hud-banner-note'), 'note class gives the line room (no truncation)')
  })
})

test('main.ts wires the opening banner into the local-match startup', () => {
  const main = readRepoFile('src/main.ts')
  assert(
    main.includes("if (gameMode === 'rts') composition.hud.announceOpening()"),
    'local (rts) startup calls hud.announceOpening() — deleting the call or its local-mode gate unwires the slice headline and must fail here',
  )
})

test('Help: the false menu claim is gone, the true paths are named', () => {
  withHudRig(({ parent }) => {
    const html = (parent as unknown as { innerHTML: string }).innerHTML
    assert(!html.includes('to build, train, save, and pick factions'), 'false claim removed')
    assert(html.includes('Build ▸'), 'names the worker Build path')
    assert(html.includes('select the building'), 'names the building-card path for train/research')
    assert(html.includes('faction picks'), 'menu line says what the menu actually holds')
  })
})

// ---------------------------------------------------------------------------
// Command card: build purposes + refusal states (card fake-DOM pattern)
// ---------------------------------------------------------------------------

interface CardEl {
  children: CardEl[]
  style: Record<string, string>
  className: string
  textContent: string
  innerHTML: string
  disabled: boolean
  appendChild(c: CardEl): CardEl
  addEventListener(): void
}

function cardEl(): CardEl {
  return {
    children: [],
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    appendChild(c: CardEl) {
      this.children.push(c)
      return c
    },
    addEventListener() {},
  }
}

function withCardDocument<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>
  const prev = g['document']
  g['document'] = { createElement: () => cardEl(), getElementById: () => null }
  try {
    return fn()
  } finally {
    if (prev === undefined) delete g['document']
    else g['document'] = prev
  }
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

interface CardButton { label: string; sub: string; note: string; disabled: boolean }

function cardButtons(el: CardEl): CardButton[] {
  const out: CardButton[] = []
  const walk = (n: CardEl): void => {
    if (n.className === 'cmd-btn') {
      const byClass = (cls: string): string =>
        n.children.find((c) => c.className === cls)?.textContent ?? ''
      out.push({
        label: byClass('cmd-btn-label'),
        sub: byClass('cmd-btn-sub'),
        note: byClass('cmd-btn-note'),
        disabled: n.disabled,
      })
    }
    for (const c of n.children) walk(c)
  }
  walk(el)
  return out
}

function renderCard(world: World, id: number, buildOpen = false): CardEl {
  return withCardDocument(() => {
    const el = cardEl()
    renderCommandCard(el as never, world, [id], cardCallbacks as never, { buildOpen })
    return el
  })
}

suite('basics slice 2: command-card honesty')

test('build menu at boot treasury: purpose, shortfall, and lock each on their entry', () => {
  const world = makeWorld() // boot treasury: 200g / 100w, human
  const worker = findEntity(world, KIND_WORKER, TEAM_PLAYER)
  const buttons = cardButtons(renderCard(world, worker, true))
  const byLabel = new Map(buttons.map((b) => [b.label, b]))
  // Farm is affordable at boot: its purpose shows, derived from the table.
  assertEqual(byLabel.get('Farm')?.note, 'Supply +6', 'farm purpose')
  assertEqual(byLabel.get('Farm')?.disabled, false, 'farm enabled')
  // Barracks is 10 wood short at boot: the shortfall, not silence.
  assertEqual(byLabel.get('Barracks')?.note, '10 more wood', 'barracks shortfall')
  assertEqual(byLabel.get('Barracks')?.disabled, true, 'barracks disabled')
  // Smithy is tech-gated: the lock outranks its (also real) shortfall.
  assertEqual(byLabel.get('Smithy')?.note, 'Needs Workshop', 'smithy lock')
  // Tower is affordable: purpose shows.
  assertEqual(byLabel.get('Tower')?.note, 'Shoots enemies', 'tower purpose')
})

test('train button: supply refusal stays live with the reason; gold refusal disables with the amount', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  // Gold-blocked: disabled, note names the missing amount.
  world.gold[TEAM_PLAYER] = 40
  let peasant = cardButtons(renderCard(world, hall)).find((b) => b.label === 'Peasant')
  assertEqual(peasant?.disabled, true, 'gold-blocked train button disabled')
  assertEqual(peasant?.note, '10 more gold', 'gold shortfall on the note line')
  // Supply-blocked with gold plentiful: button LIVE (the tap surfaces
  // the banner), note names the state.
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  world.supplyUsed[TEAM_PLAYER] = world.supplyCap[TEAM_PLAYER]
  peasant = cardButtons(renderCard(world, hall)).find((b) => b.label === 'Peasant')
  assertEqual(peasant?.disabled, false, 'supply-blocked train button stays live')
  assertEqual(peasant?.note, 'Supply full', 'supply state on the note line')
})

test('archery gate on the card: ranged sub names the requirement and disables', () => {
  const world = makeWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, -20, -40, true).id
  world.gold[TEAM_PLAYER] = 10000
  world.wood[TEAM_PLAYER] = 10000
  const buttons = cardButtons(renderCard(world, barracks))
  const ranged = buttons.find((b) => b.label === 'Longbowman')
  assertEqual(ranged?.disabled, true, 'ranged disabled without a range')
  assertEqual(ranged?.sub, 'Requires Archery Range', 'gate named on the sub line')
  const melee = buttons.find((b) => b.label === 'Footman')
  assertEqual(melee?.disabled, false, 'melee live')
})
