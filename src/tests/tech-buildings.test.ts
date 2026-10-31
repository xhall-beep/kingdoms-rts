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
 *  - Balance Slice 1 (2026-10-27): the Workshop and Range were
 *    repriced gold→wood (90g/130w, 110g/190w — the build-menu price
 *    pins below follow the data table, and the AI opening gained the
 *    infantry commitment gate: no second tech building starts before
 *    the personality's opening melee is in production. Proving fix
 *    (same day): the gate is opening-only — it retires for the match
 *    once both chain buildings have stood finished, so a mid-game
 *    wipe re-techs without re-assembling the commitment; a tech
 *    building destroyed before completing retires nothing.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_MELEE,
  KIND_RANGED,
  KIND_BARRACKS,
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
  trainingQueueFor,
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

test('build menu always shows tech entries, greyed "Needs Workshop" until one stands', () => {
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
  assert(smithyBtn!.disabled && smithyBtn!.note === 'Needs Workshop', 'smithy greyed with its reason')
  assert(archeryBtn!.disabled && archeryBtn!.note === 'Needs Workshop', 'archery greyed with its reason')
  assert(smithyBtn!.sub === '160g 120w', 'smithy price stays visible while locked')
  assert(archeryBtn!.sub === '110g 190w', 'archery price stays visible while locked')
  assert(workshopBtn!.note === 'Unlocks tech', 'unlocked entries carry their purpose on the note line (basics slice 2, audit F9; the line still renders in every state — same cell geometry)')

  world.spawnBuilding('workshop', TEAM_PLAYER, 10, 10, true)
  buttons = cardButtons(renderCard(world, worker.id, true))
  const smithyAfter = buttons.find((b) => b.label === 'Smithy')
  const archeryAfter = buttons.find((b) => b.label === 'Archery')
  assert(smithyAfter !== undefined && !smithyAfter.disabled, 'smithy live once a workshop stands')
  assert(archeryAfter !== undefined && !archeryAfter.disabled, 'archery live once a workshop stands')
  assert(smithyAfter!.note === 'Weapon + Armor' && archeryAfter!.note === 'Unlocks archers', 'note line shows each purpose once unlocked (basics slice 2)')
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

// ---------------------------------------------------------------------------
// Opening infantry commitment (Balance Slice 1, 2026-10-27)
// ---------------------------------------------------------------------------

suite('tech buildings: opening infantry commitment')

/** Melee a team has committed: fielded + active training slot + queue. */
function committedMelee(world: World, team: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.team[id] !== team) continue
    if (world.kind[id] === KIND_MELEE) n += 1
    if (world.kind[id] === KIND_BARRACKS) {
      if (world.trainKind[id] === KIND_MELEE) n += 1
      for (const queued of trainingQueueFor(world, id)) {
        if (queued === 'melee') n += 1
      }
    }
  }
  return n
}

test('each personality commits its opening melee before its second tech building starts', () => {
  // The commitment each personality owes before the Smithy / Range may
  // start (OPENING_MELEE_COMMITMENT in ai/opponent.ts): the aggressor
  // heaviest at 3, defender and expander at 2. The pre-slice AI started
  // the whole chain with zero soldiers committed (balance series
  // 2026-10-26: army value 0 at first blood in 8 of 9 rush cells).
  const personalities = [
    ['aggressor', 3],
    ['defender', 2],
    ['expander', 2],
  ] as const
  for (const [personality, commitment] of personalities) {
    const world = makeWorld()
    world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', personality))
    world.registerSystem(new OpponentAI(TEAM_ENEMY, 'normal', 'expander'))
    const cap = 60 * 60 * 6 // 6 sim-minutes: the chain must be under way
    let step = 0
    let startedAt = -1
    let committedAtStart = 0
    while (step < cap) {
      world.update(1 / 60)
      step += 1
      let secondTechStarted = false
      for (const id of world.entities.keys()) {
        if (world.team[id] !== TEAM_PLAYER) continue
        if (world.kind[id] === KIND_SMITHY || world.kind[id] === KIND_ARCHERY) {
          secondTechStarted = true
          break
        }
      }
      if (secondTechStarted) {
        startedAt = step
        committedAtStart = committedMelee(world, TEAM_PLAYER)
        break
      }
    }
    assert(
      startedAt !== -1,
      `${personality}: the second tech building starts within 6 minutes (the gate lifts)`,
    )
    assert(
      committedAtStart >= commitment,
      `${personality}: ${committedAtStart} melee committed when its second tech building started (commitment ${commitment})`,
    )
  }
})

test('after the chain has stood, a wiped AI re-techs without re-assembling the opening commitment', () => {
  // The proving series' recovery cell (2026-10-27): with the gate
  // counting from live state, a mid-game wipe + tech loss under
  // pressure froze the AI's tech forever — survival spending never
  // assembled the commitment while the tech want sat nulled. The gate
  // is opening-only: once both chain buildings have stood finished,
  // it retires, and re-tech runs on the chain's own timing.
  const world = makeWorld()
  world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'defender'))
  const team = TEAM_PLAYER
  let step = 0
  const stepOnce = (): void => {
    world.update(1 / 60)
    step += 1
  }
  const finished = (kind: number): number => {
    for (const id of world.entities.keys()) {
      if (
        world.team[id] === team &&
        world.kind[id] === kind &&
        world.buildProgress[id] >= world.buildTotal[id]
      ) {
        return id
      }
    }
    return -1
  }
  // Phase 1: the defender's full chain stands (defender order: the
  // Smithy is techFirst, the Archery Range is techSecond).
  const cap = 60 * 60 * 6
  while (step < cap && (finished(KIND_SMITHY) === -1 || finished(KIND_ARCHERY) === -1)) stepOnce()
  assert(
    finished(KIND_SMITHY) !== -1 && finished(KIND_ARCHERY) !== -1,
    'the defender completes its tech chain',
  )
  // A few more thinks so the AI has observed the finished chain (the
  // retirement latch polls at think time), then stage the loss: the
  // second tech building destroyed and the fielded army wiped — the
  // proving cell's staging, minus the enemy pressure (pressure was
  // the amplifier, not the mechanism; the gate is what's on trial).
  for (let i = 0; i < 120; i += 1) stepOnce()
  world.removeEntityById(finished(KIND_ARCHERY))
  for (const id of [...world.entities.keys()]) {
    if (world.team[id] === team && world.kind[id] === KIND_MELEE) world.removeEntityById(id)
  }
  // Resources allow from here on; the bounded window runs from now.
  world.gold[team] = 2000
  world.wood[team] = 2000
  // Phase 2: re-tech must begin promptly, and — the discriminating
  // half — it must begin while the committed melee (measured as the
  // step begins, the state the AI's expand() decides on) is still
  // BELOW the defender commitment of 2. Under the old gate the site
  // could only appear after re-commitment; a site appearing now
  // proves the gate stayed retired.
  let reTechStep = -1
  let committedBeforeReTech = -1
  const window = 60 * 60 // 60 sim-seconds
  for (let i = 0; i < window; i += 1) {
    const committedNow = committedMelee(world, team)
    stepOnce()
    let site = false
    for (const id of world.entities.keys()) {
      if (world.team[id] === team && world.kind[id] === KIND_ARCHERY) {
        site = true
        break
      }
    }
    if (site) {
      reTechStep = step
      committedBeforeReTech = committedNow
      break
    }
  }
  assert(reTechStep !== -1, 're-tech begins within 60s once resources allow')
  assert(
    committedBeforeReTech !== -1 && committedBeforeReTech < 2,
    `re-tech began with ${committedBeforeReTech} melee committed — below the defender commitment (2), so no re-commitment was demanded`,
  )
})

test('a tech building destroyed before it ever completes does not retire the opening gate', () => {
  // Opening purity (the other side of the retirement line): if the
  // second tech building is destroyed UNDER CONSTRUCTION, the chain
  // never stood, the gate must stay live, and the re-attempt must
  // wait for the opening commitment like any opening placement.
  const world = makeWorld()
  world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'defender'))
  rich(world, TEAM_PLAYER) // Timing is construction's, not the economy's.
  const team = TEAM_PLAYER
  let step = 0
  const stepOnce = (): void => {
    world.update(1 / 60)
    step += 1
  }
  const findKind = (kind: number, finishedOnly: boolean): number => {
    for (const id of world.entities.keys()) {
      if (world.team[id] !== team || world.kind[id] !== kind) continue
      if (finishedOnly && world.buildProgress[id] < world.buildTotal[id]) continue
      return id
    }
    return -1
  }
  // Run until the Smithy stands finished and the Archery site exists
  // still under construction (10s build — a wide observation window).
  const cap = 60 * 60 * 6
  let siteId = -1
  while (step < cap) {
    stepOnce()
    const candidate = findKind(KIND_ARCHERY, false)
    if (
      findKind(KIND_SMITHY, true) !== -1 &&
      candidate !== -1 &&
      world.buildProgress[candidate] < world.buildTotal[candidate]
    ) {
      siteId = candidate
      break
    }
  }
  assert(siteId !== -1, 'the archery site is observed under construction after the smithy stood')
  // Stage: the site is destroyed before ever completing, the fielded
  // melee are wiped, and the barracks (with its in-flight production)
  // goes too — committed melee is exactly 0 and must be re-assembled
  // from nothing, so the gate's demand is fully observable.
  world.removeEntityById(siteId)
  for (const id of [...world.entities.keys()]) {
    if (world.team[id] !== team) continue
    if (world.kind[id] === KIND_MELEE || world.kind[id] === KIND_BARRACKS) {
      world.removeEntityById(id)
    }
  }
  assertEqual(committedMelee(world, team), 0, 'staging leaves zero melee committed')
  // The re-attempt may only appear AFTER the commitment is re-met —
  // the exact ordering the recovery test inverts.
  let committed2Step = -1
  let reSiteStep = -1
  const window = 60 * 60 * 3
  for (let i = 0; i < window && (committed2Step === -1 || reSiteStep === -1); i += 1) {
    if (committed2Step === -1 && committedMelee(world, team) >= 2) committed2Step = step
    stepOnce()
    if (reSiteStep === -1 && findKind(KIND_ARCHERY, false) !== -1) reSiteStep = step
  }
  assert(committed2Step !== -1, 'the AI re-assembles its opening commitment (the opening still functions)')
  assert(reSiteStep !== -1, 'the archery is re-attempted once the gate lifts')
  assert(
    reSiteStep > committed2Step,
    `the re-attempt (step ${reSiteStep}) waited for re-commitment (step ${committed2Step}) — the gate stayed live`,
  )
})
