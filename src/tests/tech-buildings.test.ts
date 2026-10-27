/**
 * Tech buildings slice (2026-10-26, Montz's design directive):
 * upgrades must NOT come automatically with the barracks — a Workshop
 * (the tech root) gates the Smithy and the Archery Range; the Smithy
 * hosts the melee ladders; archers are hired at the BARRACKS, but only
 * once a finished Archery Range stands.
 *
 * Rules pinned here:
 *  - Placement: smithy/archery placement is rejected until a FINISHED
 *    own workshop stands (under construction is not enough), enforced
 *    at the placement command layer and shown greyed in the build menu.
 *  - Research routing: meleeDmg/meleeHp research only at a finished
 *    smithy; rangedDmg only at the range; the barracks hosts none.
 *  - Archer gating: ranged enqueue at the barracks rejects while no
 *    finished range stands, re-locks when the range is destroyed, and
 *    already-queued / in-training ranged items CONTINUE to completion
 *    (the chosen in-flight rule).
 *  - The mixed barracks queue keeps the standing semantics: cap 8
 *    total, costs at queue time, full refunds, supply commitment.
 *  - AI-vs-AI: both personalities build the full tech chain, field
 *    archers, research, sound the War Horn, and finish the match.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_RANGED,
  KIND_WORKSHOP,
  KIND_SMITHY,
  KIND_ARCHERY,
} from '../core/World.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import {
  enqueueTrain,
  cancelTrainQueued,
  trainQueueCount,
  researchUpgrade,
  productionCommittedSupply,
  MAX_TRAIN_QUEUE,
} from '../systems/production.ts'
import { canPlaceStructure, placeStructure } from '../world/construction.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { renderCommandCard } from '../ui/command-card.ts'

function rich(world: World, team: number): void {
  world.gold[team] = 100000
  world.wood[team] = 100000
}

/** Bare world with production only — queue mechanics without a scenario. */
function productionWorld(): World {
  const world = new World()
  world.registerSystem(new ProductionSystemImpl())
  rich(world, TEAM_PLAYER)
  world.supplyCap[TEAM_PLAYER] = 200
  return world
}

// ---------------------------------------------------------------------------
// Placement gating
// ---------------------------------------------------------------------------

suite('tech buildings: placement gating')

test('smithy and archery placement are rejected without a workshop', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  assert(!canPlaceStructure(world, TEAM_PLAYER, 'smithy', 30, 0), 'smithy locked without workshop')
  assert(!canPlaceStructure(world, TEAM_PLAYER, 'archery', -30, 0), 'archery locked without workshop')
  const goldBefore = world.gold[TEAM_PLAYER]
  const placed = placeStructure(world, TEAM_PLAYER, 'smithy', 30, 0)
  assert(!placed.ok, 'placement command rejects the smithy')
  assertEqual(world.gold[TEAM_PLAYER], goldBefore, 'a rejected placement charges nothing')
  // The workshop itself is never gated.
  assert(canPlaceStructure(world, TEAM_PLAYER, 'workshop', 0, 30), 'workshop places freely')
})

test('a workshop under construction does not unlock tech placement', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  world.spawnBuilding('workshop', TEAM_PLAYER, 0, 0, false) // still being built
  assert(!canPlaceStructure(world, TEAM_PLAYER, 'smithy', 30, 0), 'smithy still locked')
  assert(!canPlaceStructure(world, TEAM_PLAYER, 'archery', -30, 0), 'archery still locked')
})

test('a finished workshop unlocks smithy and archery placement', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  world.spawnBuilding('workshop', TEAM_PLAYER, 0, 0, true)
  assert(canPlaceStructure(world, TEAM_PLAYER, 'smithy', 30, 0), 'smithy unlocked')
  assert(canPlaceStructure(world, TEAM_PLAYER, 'archery', -30, 0), 'archery unlocked')
  const placed = placeStructure(world, TEAM_PLAYER, 'smithy', 30, 0)
  assert(placed.ok && placed.id > 0, 'smithy placement goes through once unlocked')
  // The enemy's workshop does not count — the gate is per-team.
  const foe = new World()
  foe.gold[TEAM_ENEMY] = 100000
  foe.wood[TEAM_ENEMY] = 100000
  foe.spawnBuilding('workshop', TEAM_ENEMY, 0, 0, true)
  assert(!canPlaceStructure(foe, TEAM_PLAYER, 'smithy', 30, 0), "the enemy's workshop unlocks nothing")
})

// ---------------------------------------------------------------------------
// Research routing
// ---------------------------------------------------------------------------

suite('tech buildings: research routing')

test('the barracks hosts no research; the smithy hosts the melee ladders', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, -20, 0, true)
  const goldBefore = world.gold[TEAM_PLAYER]
  assert(!researchUpgrade(world, barracks.id, 'meleeDmg'), 'barracks rejects weapon research')
  assert(!researchUpgrade(world, barracks.id, 'meleeHp'), 'barracks rejects armor research')
  assertEqual(world.meleeDmgLvl[TEAM_PLAYER], 0, 'no level snuck in at the barracks')
  assertEqual(world.gold[TEAM_PLAYER], goldBefore, 'rejected research charges nothing')

  const smithy = world.spawnBuilding('smithy', TEAM_PLAYER, 20, 0, true)
  assert(researchUpgrade(world, smithy.id, 'meleeDmg'), 'smithy researches weapons')
  assert(researchUpgrade(world, smithy.id, 'meleeHp'), 'smithy researches armor')
  assertEqual(world.meleeDmgLvl[TEAM_PLAYER], 1, 'weapon level landed')
  assertEqual(world.meleeHpLvl[TEAM_PLAYER], 1, 'armor level landed')
  assert(!researchUpgrade(world, smithy.id, 'rangedDmg'), 'smithy rejects the ranged ladder')
})

test('ranged research stays at the archery range', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  const range = world.spawnBuilding('archery', TEAM_PLAYER, 0, 20, true)
  assert(researchUpgrade(world, range.id, 'rangedDmg'), 'range researches its ladder')
  assertEqual(world.rangedDmgLvl[TEAM_PLAYER], 1, 'ranged level landed')
  assert(!researchUpgrade(world, range.id, 'meleeDmg'), 'range rejects melee research')
})

test('an unfinished tech building cannot research', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  const smithy = world.spawnBuilding('smithy', TEAM_PLAYER, 0, 0, false)
  assert(!researchUpgrade(world, smithy.id, 'meleeDmg'), 'no research under construction')
})

// ---------------------------------------------------------------------------
// Archer gating at the barracks
// ---------------------------------------------------------------------------

suite('tech buildings: archer gating')

test('ranged enqueue at the barracks rejects until a finished range stands', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  assert(!enqueueTrain(world, barracks.id, 'ranged'), 'no range: archer refused')
  assert(enqueueTrain(world, barracks.id, 'melee'), 'no range: melee still trains')
  world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, false) // under construction
  assert(!enqueueTrain(world, barracks.id, 'ranged'), 'range under construction: still refused')
})

test('a finished range unlocks archers; losing it re-locks new hires but queued archers finish', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  const range = world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, true)
  assert(enqueueTrain(world, barracks.id, 'ranged'), 'range standing: archer accepted')
  assert(enqueueTrain(world, barracks.id, 'ranged'), 'second archer queued behind the first')
  // The range falls. New hires lock again — but the two archers already
  // paid for are in flight and must complete (the chosen rule).
  world.removeEntityById(range.id)
  assert(!enqueueTrain(world, barracks.id, 'ranged'), 'range destroyed: new archers locked again')
  assert(enqueueTrain(world, barracks.id, 'melee'), 'melee is unaffected by the range falling')
  let archers = 0
  for (let t = 0; t < 60 * 30 && archers < 2; t += 1) {
    stepWorld(world, 1)
    archers = 0
    for (const id of world.entities.keys()) {
      if (world.kind[id] === KIND_RANGED && world.team[id] === TEAM_PLAYER) archers += 1
    }
  }
  assertEqual(archers, 2, 'both in-flight archers completed after the range fell')
})

// ---------------------------------------------------------------------------
// Mixed barracks queue semantics
// ---------------------------------------------------------------------------

suite('tech buildings: mixed barracks queue')

test('the cap of 8 total holds across mixed melee and ranged', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, true)
  for (let i = 0; i < MAX_TRAIN_QUEUE; i += 1) {
    const type = i % 2 === 0 ? 'melee' : 'ranged'
    assert(enqueueTrain(world, barracks.id, type), `mixed item ${i + 1} accepted`)
  }
  assertEqual(trainQueueCount(world, barracks.id), 8, 'mixed queue at the cap')
  assert(!enqueueTrain(world, barracks.id, 'melee'), '9th melee refused')
  assert(!enqueueTrain(world, barracks.id, 'ranged'), '9th ranged refused')
})

test('cancelling a queued item refunds its own price, not its neighbour\'s', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, true)
  assert(enqueueTrain(world, barracks.id, 'melee'), 'melee takes the active slot')
  const goldBeforeRanged = world.gold[TEAM_PLAYER]
  assert(enqueueTrain(world, barracks.id, 'ranged'), 'ranged waits in the queue')
  const rangedPrice = goldBeforeRanged - world.gold[TEAM_PLAYER]
  assert(enqueueTrain(world, barracks.id, 'melee'), 'a second melee waits behind')
  const goldBeforeCancel = world.gold[TEAM_PLAYER]
  assert(cancelTrainQueued(world, barracks.id, 0), 'cancel the waiting ranged item')
  assertEqual(
    world.gold[TEAM_PLAYER] - goldBeforeCancel,
    rangedPrice,
    'the refund is exactly the ranged price',
  )
  assertEqual(trainQueueCount(world, barracks.id), 2, 'active melee + waiting melee remain')
})

test('supply commitment counts mixed items at their own population', () => {
  const world = productionWorld()
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, true)
  assert(enqueueTrain(world, barracks.id, 'melee'), 'melee queued (2 pop)')
  assert(enqueueTrain(world, barracks.id, 'ranged'), 'ranged queued (1 pop)')
  assertEqual(productionCommittedSupply(world, TEAM_PLAYER), 3, 'commitment is 2 + 1 across types')
})

// ---------------------------------------------------------------------------
// Command card: build menu locks + barracks archer button
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
      out.push({
        label: n.children[0]?.textContent ?? '',
        sub: n.children[1]?.textContent ?? '',
        note: n.children[2]?.textContent ?? '',
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

suite('tech buildings: command card')

test('build menu always shows tech entries, greyed "Requires Workshop" until one stands', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  let buttons = cardButtons(renderCard(world, worker.id, true))
  const smithyBtn = buttons.find((b) => b.label === 'Smithy')
  const archeryBtn = buttons.find((b) => b.label === 'Archery')
  const workshopBtn = buttons.find((b) => b.label === 'Workshop')
  assert(smithyBtn !== undefined && archeryBtn !== undefined, 'tech entries render before any workshop (fixed grid)')
  assert(workshopBtn !== undefined && !workshopBtn.disabled, 'the workshop itself is buildable')
  // Locked cells keep their price on the sub line (players plan around
  // prices) and carry the requirement on their own note line.
  assert(smithyBtn!.disabled && smithyBtn!.note === 'Requires Workshop', 'smithy greyed with its reason')
  assert(archeryBtn!.disabled && archeryBtn!.note === 'Requires Workshop', 'archery greyed with its reason')
  assert(smithyBtn!.sub === '160g 120w', 'smithy price stays visible while locked')
  assert(archeryBtn!.sub === '170g 130w', 'archery price stays visible while locked')
  assert(workshopBtn!.note === '', 'unlocked entries render an empty note line (same cell geometry)')

  world.spawnBuilding('workshop', TEAM_PLAYER, 10, 10, true)
  buttons = cardButtons(renderCard(world, worker.id, true))
  const smithyAfter = buttons.find((b) => b.label === 'Smithy')
  const archeryAfter = buttons.find((b) => b.label === 'Archery')
  assert(smithyAfter !== undefined && !smithyAfter.disabled, 'smithy live once a workshop stands')
  assert(archeryAfter !== undefined && !archeryAfter.disabled, 'archery live once a workshop stands')
  assert(smithyAfter!.note === '' && archeryAfter!.note === '', 'note line empties once unlocked')
})

test('barracks card: archer button greyed pre-range, live post-range, and no research buttons', () => {
  const world = new World()
  rich(world, TEAM_PLAYER)
  const barracks = world.spawnBuilding('barracks', TEAM_PLAYER, 0, 0, true)
  let buttons = cardButtons(renderCard(world, barracks.id))
  assert(
    !buttons.some((b) => b.label.startsWith('Weapon') || b.label.startsWith('Armor')),
    'the barracks card shows no research buttons anymore',
  )
  const archer = buttons.find((b) => b.label === 'Longbowman')
  assert(archer !== undefined, 'the archer button renders on the barracks card')
  assert(archer!.disabled && archer!.sub === 'Requires Archery Range', 'archer greyed with its reason pre-range')

  world.spawnBuilding('archery', TEAM_PLAYER, 30, 0, true)
  buttons = cardButtons(renderCard(world, barracks.id))
  const archerAfter = buttons.find((b) => b.label === 'Longbowman')
  assert(archerAfter !== undefined && !archerAfter.disabled, 'archer live once a range stands')

  const smithy = world.spawnBuilding('smithy', TEAM_PLAYER, -30, 0, true)
  const smithyButtons = cardButtons(renderCard(world, smithy.id))
  assert(
    smithyButtons.some((b) => b.label.startsWith('Weapon')) &&
      smithyButtons.some((b) => b.label.startsWith('Armor')),
    'the smithy card hosts the melee ladders',
  )
})

// ---------------------------------------------------------------------------
// AI-vs-AI full-match probe
// ---------------------------------------------------------------------------

suite('tech buildings: AI-vs-AI probe')

test('both AIs build the tech chain, field archers, research, sound the horn, and finish', () => {
  const world = makeWorld()
  world.registerSystem(new OpponentAI(0, 'normal', 'expander'))
  world.registerSystem(new OpponentAI(1, 'normal', 'aggressor'))
  const techSeen: Array<Set<number>> = [new Set(), new Set()]
  const archersSeen = [false, false]
  let prevKind = [world.rallyKind[0], world.rallyKind[1]]
  let prevCharge = [world.warCharge[0], world.warCharge[1]]
  let hornFired = false
  const cap = 60 * 60 * 15 // 15 sim-minutes is generous — the reference run ended at 8:33
  let step = 0
  while (world.winner === -1 && step < cap) {
    world.update(1 / 60)
    step += 1
    if (step % 300 !== 0 && world.winner === -1) continue
    for (const id of world.entities.keys()) {
      const t = world.team[id]
      const k = world.kind[id]
      if (
        (k === KIND_WORKSHOP || k === KIND_SMITHY || k === KIND_ARCHERY) &&
        world.buildProgress[id] >= world.buildTotal[id]
      ) {
        techSeen[t].add(k)
      }
      if (k === KIND_RANGED) archersSeen[t] = true
    }
    for (const t of [0, 1] as const) {
      if (!hornFired && prevKind[t] === 0 && world.rallyKind[t] !== 0) hornFired = true
      else if (
        !hornFired &&
        world.rallyKind[t] === 0 &&
        prevCharge[t] - world.warCharge[t] >= 30 &&
        world.tick - world.warLastTick[t] <= 2700
      ) {
        hornFired = true
      }
      prevKind[t] = world.rallyKind[t]
      prevCharge[t] = world.warCharge[t]
    }
  }
  assert(world.winner !== -1, `the match completes with a winner (t=${world.matchTime.toFixed(0)}s)`)
  for (const t of [0, 1] as const) {
    assert(
      techSeen[t].has(KIND_WORKSHOP) && techSeen[t].has(KIND_SMITHY) && techSeen[t].has(KIND_ARCHERY),
      `team ${t} built workshop + smithy + archery range (saw ${[...techSeen[t]].join(',')})`,
    )
    assert(archersSeen[t], `team ${t} fielded archers`)
    const levels = world.meleeDmgLvl[t] + world.meleeHpLvl[t] + world.rangedDmgLvl[t]
    assert(levels >= 1, `team ${t} researched at least one upgrade (levels ${levels})`)
  }
  assert(hornFired, 'the War Horn still fires in a tech-chain match')
})
