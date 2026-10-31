/**
 * Labels + wrath slice (2026-10-26): the prices the command card
 * prints must be the prices the sim charges, and the Living Wild
 * wrath meter must map sim state to its five segments faithfully.
 *
 * The label defects pinned here (all found by the label sweep):
 *  - Research buttons hardcoded the base '100g 50w' while
 *    researchCost charges human (the default faction) 80g/40w via
 *    the Adaptable signature — label overstated, and the button
 *    stayed disabled until the player held the full base cost.
 *  - Train buttons and the unit stat line printed the raw table cost
 *    while trainCostFor charges the faction-modified price (undead
 *    melee: showed 100g/30w, charged 85g/26w).
 *  - The farm card's supply grant was a literal string (it read +8
 *    for a +6 farm until fixed by hand); it is now derived from the
 *    building data — proven here by mutating the data.
 */
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'
import { World, TEAM_PLAYER } from '../core/World.ts'
import { makeWorld } from './setup.ts'
import { HudImpl, wildWrathDisplay } from '../ui/hud.ts'
import { renderCommandCard } from '../ui/command-card.ts'
import { BUILDINGS } from '../data/buildings.ts'
import { WILD_HEAT_THRESHOLD } from '../systems/living-wild.ts'

// ---------------------------------------------------------------------------
// FIX L2 — sim → display mapping (pure)
// ---------------------------------------------------------------------------

suite('wrath meter: wildWrathDisplay mapping')

test('zero heat: empty meter, quiet band', () => {
  const world = new World()
  const d = wildWrathDisplay(world)
  assertEqual(d.fraction, 0, 'fraction')
  assertEqual(d.segments, 0, 'segments')
  assertEqual(d.band, 'quiet', 'band')
})

test('segments fill one per fifth of the threshold', () => {
  const world = new World()
  const cases: Array<[number, number]> = [
    [45, 1], // 10%
    [90, 1], // exactly 20% — first segment full
    [225, 3], // 50%
    [270, 3], // exactly 60% — third segment full
    [342, 4], // 76%
    [450, 5], // threshold itself
    [1200, 5], // over-threshold clamps at full
  ]
  for (const [heat, want] of cases) {
    world.wildHeat[TEAM_PLAYER] = heat
    const d = wildWrathDisplay(world)
    assertEqual(d.segments, want, `segments at heat ${heat}`)
    assertClose(d.fraction, Math.min(1, heat / WILD_HEAT_THRESHOLD), 1e-9, `fraction at heat ${heat}`)
  }
})

test('bands: quiet below 60%, amber from 60%, hot from 85%', () => {
  const world = new World()
  const bandAt = (heat: number): string => {
    world.wildHeat[TEAM_PLAYER] = heat
    return wildWrathDisplay(world).band
  }
  assertEqual(bandAt(269), 'quiet', 'just under 60% stays quiet')
  assertEqual(bandAt(270), 'amber', '60% turns amber (fourth segment in play)')
  assertEqual(bandAt(382), 'amber', 'just under 85% stays amber')
  assertEqual(bandAt(383), 'hot', '85% turns hot')
  assertEqual(bandAt(450), 'hot', 'threshold is hot')
})

test('only the player team heat drives the meter', () => {
  const world = new World()
  world.wildHeat[1] = WILD_HEAT_THRESHOLD
  world.wildHeat[TEAM_PLAYER] = 0
  const d = wildWrathDisplay(world)
  assertEqual(d.fraction, 0, 'enemy heat does not move the player meter')
  assertEqual(d.segments, 0, 'segments')
})

// ---------------------------------------------------------------------------
// FIX L2 — HUD wiring against a fake DOM (experience-fixes pattern)
// ---------------------------------------------------------------------------

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

suite('wrath meter: HUD sliver wiring')

test('sliver renders segments + band from sim state, VP untouched', () => {
  const restoreLs = stubLocalStorage()
  const restoreDoc = stubDocument()
  try {
    const parent = new FakeEl()
    for (const sel of ['#hud-menu', '#hud-banner', '#hud-pvp-status', '#hud-tutorial', '#hud-tutorial-backdrop', '#hud-speed', '#hud-surrender']) {
      parent.primeHidden(sel)
    }
    const hud = new HudImpl()
    hud.mount(parent as unknown as HTMLElement)
    const world = makeWorld()
    const wildEl = parent.querySelector('#hud-wild')
    const segs = wildEl.querySelectorAll('.hud-wild-seg')
    const litCount = (): number => segs.filter((s) => s.classList.contains('hud-wild-seg-on')).length

    world.wildHeat[TEAM_PLAYER] = 342 // 76%: four segments, amber
    hud.update(world, [])
    assertEqual(litCount(), 4, 'four segments lit at 76%')
    assert(wildEl.className.includes('hud-wild-amber'), 'amber band class at 76%')
    assertEqual(parent.querySelector('#hud-info').textContent, 'VP 1000', 'VP still renders in full')

    world.wildHeat[TEAM_PLAYER] = 0 // decayed away: cell persists, empties
    hud.update(world, [])
    assertEqual(litCount(), 0, 'no segments lit at zero')
    assert(wildEl.className.includes('hud-wild-quiet'), 'quiet band class at zero')

    world.wildHeat[TEAM_PLAYER] = 405 // 90%: full, hot
    hud.update(world, [])
    assertEqual(litCount(), 5, 'five segments lit at 90%')
    assert(wildEl.className.includes('hud-wild-hot'), 'hot band class at 90%')
  } finally {
    restoreLs()
    restoreDoc()
  }
})

// ---------------------------------------------------------------------------
// FIX L1 — command-card prices are the charged prices
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

function collectText(el: CardEl): string {
  return [el.textContent, ...el.children.map(collectText)].join(' ')
}

interface CardButton { label: string; sub: string; disabled: boolean }

function cardButtons(el: CardEl): CardButton[] {
  const out: CardButton[] = []
  const walk = (n: CardEl): void => {
    if (n.className === 'cmd-btn') {
      out.push({
        label: n.children[0]?.textContent ?? '',
        sub: n.children[1]?.textContent ?? '',
        disabled: n.disabled,
      })
    }
    for (const c of n.children) walk(c)
  }
  walk(el)
  return out
}

function renderCard(world: World, id: number): CardEl {
  return withCardDocument(() => {
    const el = cardEl()
    renderCommandCard(el as never, world, [id], cardCallbacks as never, {})
    return el
  })
}

suite('labels: command-card prices match the sim')

test('farm card supply grant is derived from the building data', () => {
  const world = new World()
  const farm = world.spawnBuilding('farm', TEAM_PLAYER, 0, 0, true)
  assert(collectText(renderCard(world, farm.id)).includes('Supply +6'), 'farm card shows the data grant (+6)')
  const original = BUILDINGS.farm.supply
  try {
    BUILDINGS.farm.supply = 9
    assert(
      collectText(renderCard(world, farm.id)).includes('Supply +9'),
      'farm card follows the data when the data changes (no literal)',
    )
  } finally {
    BUILDINGS.farm.supply = original
  }
})

test('human research buttons price at the Adaptable 80g/40w and enable at that price', () => {
  const world = new World() // default factions: human player
  world.gold[TEAM_PLAYER] = 85
  world.wood[TEAM_PLAYER] = 45
  // Since the tech-buildings rework the melee ladders live at the Smithy.
  const smithy = world.spawnBuilding('smithy', TEAM_PLAYER, 0, 0, true)
  const buttons = cardButtons(renderCard(world, smithy.id))
  const weapon = buttons.find((b) => b.label === 'Weapon +1')
  const armor = buttons.find((b) => b.label === 'Armor +1')
  assert(weapon !== undefined && armor !== undefined, 'both research buttons render')
  assertEqual(weapon?.sub, '80g 40w', 'weapon price is the charged human price')
  assertEqual(armor?.sub, '80g 40w', 'armor price is the charged human price')
  assertEqual(weapon?.disabled, false, 'weapon research enabled at 85g/45w (the real price)')
  assertEqual(armor?.disabled, false, 'armor research enabled at 85g/45w (the real price)')
})

test('undead train prices carry the faction cost modifier', () => {
  const world = new World()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const buttons = cardButtons(renderCard(world, hall.id))
  const husk = buttons.find((b) => b.label === 'Husk')
  assert(husk !== undefined, 'undead worker train button renders')
  assertEqual(husk?.sub, '50g 0w', 'husk priced at round(50 x 1.0) — the charged faction price (normalized 2026-10-30)')
})

test('undead unit stat line prices the unit at its faction price', () => {
  const world = new World()
  world.factionOfTeam[TEAM_PLAYER] = 'undead'
  const melee = world.spawnUnit('melee', TEAM_PLAYER, 100, 100)
  const text = collectText(renderCard(world, melee.id))
  assert(text.includes('100g 30w'), 'stat line shows the charged undead melee price (faction price = base at cost 1.0)')
  assert(!text.includes('85g 26w'), 'stat line no longer shows the old 0.85-discounted price')
})

test('human prices are unchanged (modifier 1.0 control)', () => {
  const world = new World()
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const buttons = cardButtons(renderCard(world, hall.id))
  const peasant = buttons.find((b) => b.label === 'Peasant')
  assertEqual(peasant?.sub, '50g 0w', 'human peasant still priced at base')
})

test('orc tier button prices from the production tier table', () => {
  const world = new World()
  world.factionOfTeam[TEAM_PLAYER] = 'orc'
  world.gold[TEAM_PLAYER] = 1000
  world.wood[TEAM_PLAYER] = 1000
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const buttons = cardButtons(renderCard(world, hall.id))
  // The button names the tier it reforges TO (ORC_TIER_NAMES[tier]);
  // a fresh hall is tier 1, so the 1->2 button reads 'Blood-Forged'.
  const upgrade = buttons.find((b) => b.label.includes('Blood-Forged'))
  assert(upgrade !== undefined, 'orc tier upgrade button renders')
  assertEqual(upgrade?.sub, '150g 100w', 'tier 1->2 priced from TIER_UPGRADES')
})
