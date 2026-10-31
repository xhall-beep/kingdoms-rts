/**
 * Basics slice 3 — "Alerts and states that explain themselves"
 * (Montz's "Improve basics", 2026-10-31; basics audit F3/F6/F8/F10).
 *
 * What is pinned here:
 *  - F3: the first enemy-shrine VP drain raises ONE banner naming the
 *    cause and the counter (VpDrainWatch + HUD rig), never a second;
 *    the enemy's VP draining is not the player's alarm; Help carries
 *    a truthful shrine/VP line.
 *  - F6: the alert chip's on-screen test carries the edge margin — a
 *    fight at the frame edge raises the chip, a centre fight does
 *    not; the Bell card states the militia terms from the system's
 *    own constants; a zero-muster ring's refusal mirrors
 *    ringMilitiaBell's guard chain exactly and phrases a reason.
 *  - F8: the selected unit's card shows its current state read from
 *    its own state fields (incl. the auto-gather assignment), every
 *    string inside the 16-char note ceiling.
 *  - F10: placementRefusal decomposes canPlaceStructure's checks with
 *    identical acceptance (sweep-pinned); your own standing worker
 *    reads as blocked-unit/own, distinct from terrain/building blocks;
 *    the ghost's amber branch and the main.ts wirings are source-pinned
 *    (the frame proof carries the visual claim).
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_TREE,
  KIND_WORKER,
  MILITIA_DURATION_SEC,
  MILITIA_MUSTER_RADIUS,
  STATE_ATTACK,
  STATE_BUILD,
  STATE_GATHER,
  STATE_MOVE,
  STATE_RETURN,
} from '../core/World.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { Renderer } from '../render/renderer.ts'
import {
  ALERT_EDGE_MARGIN_PX,
  HudImpl,
  VP_DRAIN_BANNER_TEXT,
  VpDrainWatch,
  pickAlert,
} from '../ui/hud.ts'
import type { AlertEvent } from '../core/World.ts'
import {
  BELL_TERMS_TEXT,
  militiaRefusalBannerText,
  placementRefusalBannerText,
  renderCommandCard,
  unitStateText,
} from '../ui/command-card.ts'
import {
  canPlaceStructure,
  placementRefusal,
} from '../world/construction.ts'
import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'

function findEntity(world: World, kind: number, team: number): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind && world.team[id] === team) return id
  }
  throw new Error(`entity kind ${kind} team ${team} not found`)
}

function findAny(world: World, kind: number): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === kind) return id
  }
  throw new Error(`entity kind ${kind} not found`)
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

// ---------------------------------------------------------------------------
// F3 — VP drain watch: one-shot, local team only, per-match latch
// ---------------------------------------------------------------------------

suite('basics slice 3: VP drain watch')

test('first drop fires exactly once; flat and rising VP stay silent', () => {
  const world = makeWorld()
  const watch = new VpDrainWatch()
  assertEqual(watch.observe(world), false, 'baseline observation is silent')
  assertEqual(watch.observe(world), false, 'flat VP is silent')
  world.victoryPoints[TEAM_PLAYER] -= 5
  assertEqual(watch.observe(world), true, 'first drop fires')
  world.victoryPoints[TEAM_PLAYER] -= 5
  assertEqual(watch.observe(world), false, 'second drop does not re-fire (one-shot latch)')
  world.victoryPoints[TEAM_PLAYER] += 10
  assertEqual(watch.observe(world), false, 'a rise is silent')
  world.victoryPoints[TEAM_PLAYER] -= 5
  assertEqual(watch.observe(world), false, 'a later drop still does not re-fire')
})

test("the enemy's VP draining is not the player's alarm", () => {
  const world = makeWorld()
  const watch = new VpDrainWatch()
  assertEqual(watch.observe(world), false, 'baseline')
  world.victoryPoints[TEAM_ENEMY] -= 25
  assertEqual(watch.observe(world), false, 'enemy VP drop raises nothing')
})

test('a fresh world re-arms the watch and re-baselines', () => {
  const first = makeWorld()
  const watch = new VpDrainWatch()
  watch.observe(first)
  first.victoryPoints[TEAM_PLAYER] -= 5
  assertEqual(watch.observe(first), true, 'fires in match one')
  const second = makeWorld()
  assertEqual(watch.observe(second), false, 'new match baselines silently')
  second.victoryPoints[TEAM_PLAYER] -= 5
  assertEqual(watch.observe(second), true, 'fires again in the new match')
})

test('a real shrine drain trips the watch (shrine system, staged presence)', () => {
  const world = makeWorld()
  // Enemy military standing on the central shrine (0,0): presence is
  // the upkeep — the drain runs from the first 1s check.
  world.spawnUnit('melee', TEAM_ENEMY, 3, 0)
  const watch = new VpDrainWatch()
  assertEqual(watch.observe(world), false, 'baseline before stepping')
  stepWorld(world, 130) // > 2s: at least one drain check lands
  assert(world.victoryPoints[TEAM_PLAYER] < 1000, 'the staged shrine actually drained')
  assertEqual(watch.observe(world), true, 'the drain the sim produced fires the watch')
})

// ---------------------------------------------------------------------------
// F3 + F6 — HUD rig: banner surfacing, Help line, main.ts wiring pins
// (fake-DOM rig — basics slice 2 pattern)
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

suite('basics slice 3: HUD surfaces')

test('the first VP drop raises the explanation banner, once', () => {
  withHudRig(({ hud, banner }) => {
    const world = makeWorld()
    hud.update(world, [])
    assertEqual(banner.hidden, true, 'no drain, no banner')
    world.victoryPoints[TEAM_PLAYER] -= 5
    hud.update(world, [])
    assertEqual(banner.hidden, false, 'banner shows on the first drop')
    assertEqual(banner.textContent, VP_DRAIN_BANNER_TEXT, 'the shipped explanation copy')
    assert(banner.className.includes('hud-banner-note'), 'note class (the line wraps at 412px)')
    // A second drop must not re-raise it after the lease lapses: hide
    // the banner by hand (simulating lease expiry), drop again, and
    // the lane stays empty — the latch, not the lease, is the guard.
    banner.hidden = true
    world.victoryPoints[TEAM_PLAYER] -= 5
    hud.update(world, [])
    assertEqual(banner.hidden, true, 'second drop does not re-raise the banner')
  })
})

test('Help names the shrine and the VP defeat truthfully', () => {
  withHudRig(({ parent }) => {
    const html = (parent as unknown as { innerHTML: string }).innerHTML
    assert(html.includes('Shrine & VP'), 'help has a shrine/VP line')
    assert(html.includes('VP</b> drains'), 'names the drain')
    assert(html.includes('reaches 0 loses'), 'names the defeat condition')
  })
})

test('main.ts wires the edge margin, the placement listener, and the militia refusal', () => {
  const main = readRepoFile('src/main.ts')
  assert(
    main.includes('isWorldPointOnScreen(x, z, ALERT_EDGE_MARGIN_PX)'),
    'the alert probe carries the edge margin — deleting it returns the chip to edge blindness',
  )
  assert(
    main.includes('setPlacementRefusedListener'),
    'placement refusals reach the banner lane',
  )
  assert(
    main.includes('placementRefusalBannerText(reason, type)'),
    'the listener phrases the reason for the banner',
  )
  assert(
    main.includes('ghostRefusal'),
    'the frame loop reads the ghost refusal (amber unit-blocked ghost)',
  )
  assert(
    main.includes('world.militiaRefusal(team)') && main.includes('militiaRefusalBannerText(reason)'),
    'a refused Bell ring names its reason in the banner lane',
  )
})

// ---------------------------------------------------------------------------
// F6 — alert chip edge margin (renderer probe + pickAlert)
// ---------------------------------------------------------------------------

function makeRenderer(): Renderer {
  const ctx = new Proxy({}, { get: () => () => undefined })
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return new Renderer(canvas as unknown as HTMLCanvasElement)
}

suite('basics slice 3: alert edge margin')

test('a point ~11px from the frame edge is on screen bare, off screen with the margin', () => {
  const renderer = makeRenderer()
  renderer.resize(412, 915)
  renderer.centerOn(-40, -40, 10) // the audit's boot camera
  // Screen x ≈ 401 of 412, vertically centred: the audit's first fight.
  assertEqual(renderer.isWorldPointOnScreen(-20.5, -40), true, 'bare probe: the edge fight reads as on screen')
  assertEqual(
    renderer.isWorldPointOnScreen(-20.5, -40, ALERT_EDGE_MARGIN_PX),
    false,
    'with the margin, the edge fight counts as not comfortably seen',
  )
  assertEqual(
    renderer.isWorldPointOnScreen(-40, -40, ALERT_EDGE_MARGIN_PX),
    true,
    'the camera centre stays comfortably on screen with the margin',
  )
})

test('pickAlert: edge fight raises the chip, centre fight stays down', () => {
  const renderer = makeRenderer()
  renderer.resize(412, 915)
  renderer.centerOn(-40, -40, 10)
  const probe = (x: number, z: number): boolean =>
    renderer.isWorldPointOnScreen(x, z, ALERT_EDGE_MARGIN_PX)
  const lastShown = { attack: -1000000, treant: -1000000, complete: -1000000 }
  const edge: AlertEvent = { kind: 'attack', x: -20.5, z: -40, team: TEAM_PLAYER, tick: 100 }
  const centre: AlertEvent = { kind: 'attack', x: -40, z: -40, team: TEAM_PLAYER, tick: 100 }
  assert(pickAlert([edge], TEAM_PLAYER, null, lastShown, 100, probe) !== null, 'edge fight chips')
  assertEqual(pickAlert([centre], TEAM_PLAYER, null, lastShown, 100, probe), null, 'centre fight does not chip')
})

// ---------------------------------------------------------------------------
// F6 — militia: refusal mirrors the ring; card carries the terms
// ---------------------------------------------------------------------------

suite('basics slice 3: militia bell honesty')

test('refusal and ring agree: in radius rings, then cooldown refuses', () => {
  const world = makeWorld()
  assertEqual(world.militiaRefusal(TEAM_PLAYER), null, 'boot workers stand inside the muster radius')
  assert(world.ringMilitiaBell(TEAM_PLAYER) > 0, 'the ring musters')
  assertEqual(world.militiaRefusal(TEAM_PLAYER), 'cooldown', 'a fresh ring refuses on cooldown')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'the ring itself refuses identically')
})

test('refusal and ring agree: nobody in radius musters zero and says so', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === KIND_WORKER) {
      world.positionX[id] = world.positionX[hall] + 60
      world.positionZ[id] = world.positionZ[hall] + 60
    }
  }
  assertEqual(world.militiaRefusal(TEAM_PLAYER), 'none-in-radius', 'all workers beyond the radius')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 'the ring musters zero')
  assertEqual(
    militiaRefusalBannerText('none-in-radius'),
    `No Peasants within ${MILITIA_MUSTER_RADIUS} of the Hall`,
    'the banner names the radius the system enforces',
  )
})

test('refusal and ring agree: a non-human team has no bell', () => {
  const world = makeWorld() // enemy is orc
  assertEqual(world.militiaRefusal(TEAM_ENEMY), 'unavailable', 'orc has no militia bell')
  assertEqual(world.ringMilitiaBell(TEAM_ENEMY), 0, 'the ring refuses identically')
})

// ---------------------------------------------------------------------------
// Card rig (basics slice 2 pattern)
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

function renderCard(world: World, id: number): CardEl {
  return withCardDocument(() => {
    const el = cardEl()
    renderCommandCard(el as never, world, [id], cardCallbacks as never, {})
    return el
  })
}

function statlines(el: CardEl): string[] {
  const out: string[] = []
  const walk = (n: CardEl): void => {
    if (n.className === 'cmd-statline') out.push(n.textContent)
    for (const c of n.children) walk(c)
  }
  walk(el)
  return out
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

test('hall card carries the Bell terms from the system constants', () => {
  const world = makeWorld()
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  const card = renderCard(world, hall)
  const lines = statlines(card)
  assert(lines.includes(BELL_TERMS_TEXT), 'the terms line renders on the hall card')
  assert(
    BELL_TERMS_TEXT.includes(`${MILITIA_MUSTER_RADIUS}`) &&
      BELL_TERMS_TEXT.includes(`${MILITIA_DURATION_SEC}s`) &&
      BELL_TERMS_TEXT.includes('gathering stops'),
    'terms quote the enforced radius + duration and the gathering freeze',
  )
  const bell = cardButtons(card).find((b) => b.label.includes('Bell'))
  assertEqual(bell?.note, 'No gathering', 'the button itself carries the freeze (short form — the cell ellipsizes the full wording, frame-measured)')
})

test('enemy hall card carries no Bell terms (not the viewer\u2019s verb)', () => {
  const world = makeWorld()
  const foeHall = findEntity(world, KIND_HALL, TEAM_ENEMY)
  const lines = statlines(renderCard(world, foeHall))
  assert(!lines.includes(BELL_TERMS_TEXT), 'no terms line on an enemy hall')
})

// ---------------------------------------------------------------------------
// F8 — unit card state
// ---------------------------------------------------------------------------

suite('basics slice 3: unit state line')

test('state text reads the unit\u2019s own fields, inside the note ceiling', () => {
  const world = makeWorld()
  const worker = findEntity(world, KIND_WORKER, TEAM_PLAYER)
  const tree = findAny(world, KIND_TREE)
  const mine = findAny(world, KIND_GOLDMINE)
  const seen: string[] = []
  const check = (want: string, label: string): void => {
    const got = unitStateText(world, worker)
    seen.push(got)
    assertEqual(got, want, label)
  }
  world.state[worker] = STATE_GATHER
  world.targetId[worker] = mine
  check('Gathering gold', 'gather state on a gold node')
  world.targetId[worker] = tree
  check('Gathering wood', 'gather state on a tree')
  world.state[worker] = STATE_RETURN
  check('Returning', 'return leg')
  world.state[worker] = STATE_MOVE
  check('Moving', 'move order')
  world.state[worker] = STATE_BUILD
  check('Building', 'build order')
  world.militiaUntil[worker] = world.matchTime + 10
  check('On militia duty', 'mustered worker (militia outranks its idle state)')
  world.militiaUntil[worker] = 0
  world.state[worker] = 0 // STATE_IDLE
  check('Idle', 'idle')
  const melee = world.spawnUnit('melee', TEAM_PLAYER, -30, -30)
  world.state[melee.id] = STATE_ATTACK
  assertEqual(unitStateText(world, melee.id), 'Fighting', 'attack state')
  seen.push(unitStateText(world, melee.id))
  for (const s of seen) {
    assert(s.length <= 16, `state string fits the 16-char note ceiling: "${s}" (${s.length})`)
  }
})

test('the auto-gather assignment is visible on the card from the opening ticks', () => {
  const world = makeWorld()
  stepWorld(world, 30) // auto-gather assigns every idle worker (audit: by 0:05 all gather)
  const worker = findEntity(world, KIND_WORKER, TEAM_PLAYER)
  const text = unitStateText(world, worker)
  assert(text.startsWith('Gathering'), `the worker's opening assignment reads on the card (got "${text}")`)
  const lines = statlines(renderCard(world, worker))
  assert(lines.includes(text), 'the rendered card carries the state line')
})

// ---------------------------------------------------------------------------
// F10 — placement reasons
// ---------------------------------------------------------------------------

suite('basics slice 3: placement refusal reasons')

test('equivalence: refusal is null exactly where canPlaceStructure accepts (sweep)', () => {
  const types: BuildingType[] = ['farm', 'barracks', 'workshop', 'smithy', 'archery', 'tower']
  for (const rich of [false, true]) {
    const world = makeWorld()
    if (rich) {
      world.gold[TEAM_PLAYER] = 100000
      world.wood[TEAM_PLAYER] = 100000
      world.spawnBuilding('workshop', TEAM_PLAYER, -52, -52, true)
    }
    for (const type of types) {
      for (let x = -60; x <= 60; x += 12) {
        for (let z = -60; z <= 60; z += 12) {
          const refusal = placementRefusal(world, TEAM_PLAYER, type, x, z)
          const accepts = canPlaceStructure(world, TEAM_PLAYER, type, x, z)
          assertEqual(
            refusal === null,
            accepts,
            `${type} at (${x},${z}) rich=${rich}: refusal/acceptance agree`,
          )
        }
      }
    }
  }
})

test('your own standing worker reads blocked-unit/own — distinct from terrain and buildings', () => {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  const worker = findEntity(world, KIND_WORKER, TEAM_PLAYER)
  const wx = world.positionX[worker]
  const wz = world.positionZ[worker]
  // The audit's staged case: the natural spot beside the hall refuses
  // because the player's own worker is standing in the footprint.
  const own = placementRefusal(world, TEAM_PLAYER, 'farm', wx, wz)
  assertEqual(own?.kind, 'blocked-unit', 'own worker blocks as a unit')
  assertEqual(own?.kind === 'blocked-unit' ? own.own : null, true, 'and it is the player\u2019s own')
  assertEqual(
    placementRefusalBannerText(own!, 'farm'),
    'Your own unit is standing there',
    'the banner says whose unit and why',
  )
  // The hall's own footprint: a static block, a different reason.
  const hall = findEntity(world, KIND_HALL, TEAM_PLAYER)
  const onHall = placementRefusal(world, TEAM_PLAYER, 'farm', world.positionX[hall], world.positionZ[hall])
  assertEqual(onHall?.kind, 'blocked', 'building footprint reads as a static block')
  // A tree: terrain, the same static class — never a unit.
  const tree = findAny(world, KIND_TREE)
  const onTree = placementRefusal(world, TEAM_PLAYER, 'farm', world.positionX[tree], world.positionZ[tree])
  assertEqual(onTree?.kind, 'blocked', 'a tree reads as terrain, not a unit')
})

test('an enemy unit in the footprint is blocked-unit, but not "own"', () => {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  const foe = world.spawnUnit('melee', TEAM_ENEMY, 0, 24)
  const refusal = placementRefusal(world, TEAM_PLAYER, 'farm', world.positionX[foe.id], world.positionZ[foe.id])
  assertEqual(refusal?.kind, 'blocked-unit', 'enemy unit blocks as a unit')
  assertEqual(refusal?.kind === 'blocked-unit' ? refusal.own : null, false, 'but it is not the player\u2019s')
  assertEqual(placementRefusalBannerText(refusal!, 'farm'), 'A unit is standing there', 'banner copy differs from the own-unit case')
})

test('prereq and purse refusals name themselves', () => {
  const world = makeWorld()
  world.gold[TEAM_PLAYER] = 100000
  world.wood[TEAM_PLAYER] = 100000
  const gated = placementRefusal(world, TEAM_PLAYER, 'smithy', -52, -20)
  assertEqual(gated?.kind, 'prereq', 'smithy before a finished workshop')
  assertEqual(placementRefusalBannerText(gated!, 'smithy'), 'Requires a finished Workshop', 'the gate is named')
  const broke = makeWorld()
  broke.gold[TEAM_PLAYER] = 0
  const gold = placementRefusal(broke, TEAM_PLAYER, 'farm', -52, -20)
  assertEqual(gold?.kind, 'gold', 'an empty purse refuses on gold')
  assertEqual(gold?.kind === 'gold' ? gold.short : -1, BUILDINGS.farm.cost.gold, 'shortfall is the full farm price')
})

test('renderer ghost: the amber unit-blocked branch is in the shipped draw path', () => {
  const src = readRepoFile('src/render/renderer.ts')
  assert(src.includes('ghostBlockedByUnit'), 'ghost carries the unit-blocked state')
  assert(src.includes("'#f59e0b'"), 'unit-blocked ghost draws amber, distinct from the red refusal')
  assert(src.includes('isWorldPointOnScreen(x: number, z: number, marginPx = 0)'), 'the probe takes the margin')
})
