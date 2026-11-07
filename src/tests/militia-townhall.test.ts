/**
 * Militia Bell TOWN-HALL ARMING tests (Anchor design note
 * anchor-militia-townhall-2026-11-06.md; Montz's decision 2026-11-06
 * 15:37 EST, superseding the ring-drop reading for the ring case).
 *
 * The muster is a TRIP: on the ring, eligible peasants enter
 * STATE_MUSTER and walk to their hall; on arrival they deposit their
 * load (exact RETURN semantics) and arm — the 25 s levy clock starts
 * at arming, per peasant; the 120 s cooldown starts at the ring. At
 * expiry, on-duty pikemen enter STATE_DISARM, return to the hall, and
 * revert to peasants there. The pile entity survives only as the
 * DEATH case: a peasant killed in STATE_MUSTER carrying a load leaves
 * it as a pile where he fell.
 *
 * Test names cite the note's acceptance properties (§a) and
 * counterexample classes (§b) where they pin them.
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  CARRY_GOLD,
  CARRY_WOOD,
  KIND_HALL,
  KIND_PILE,
  KIND_TREE,
  KIND_WORKER,
  MILITIA_DURATION_SEC,
  STATE_BUILD,
  STATE_DISARM,
  STATE_GATHER,
  STATE_IDLE,
  STATE_MOVE,
  STATE_MUSTER,
} from '../core/World.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { GatherSystemImpl, buildersOnSite } from '../systems/gather.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl, SEASON_WINTER } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { MovementSystemImpl, orderMove } from '../systems/movement.ts'
import { orderGather } from '../systems/gather.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { hashWorldState, hashToHex } from '../net/hash.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'
import { unitStateText } from '../ui/command-card.ts'
import { InputControllerImpl } from '../input/input-controller.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'

/** Production system order (tests/setup.ts) on a bare, unseeded world. */
function makeBareWorld(factionA = 'human', factionB = 'human', withAi = false): World {
  const world = new World()
  world.factionOfTeam = [factionA as never, factionB as never]
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new BellSystemImpl())
  world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new WarHornSystemImpl())
  world.registerSystem(new ShrineSystemImpl())
  if (withAi) world.registerSystem(new OpponentAI(TEAM_PLAYER, 'normal', 'expander'))
  world.registerSystem(new MovementSystemImpl())
  return world
}

function pilesOf(world: World, team: number): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_PILE && world.team[id] === team) out.push(id)
  }
  return out.sort((a, b) => a - b)
}

/** Conservation total (note §a-6): banked + Σ carried + Σ piled. */
function totalOf(world: World, team: 0 | 1, carryKind: number): number {
  let total = carryKind === CARRY_GOLD ? world.gold[team] : world.wood[team]
  for (const id of world.entities.keys()) {
    if (world.team[id] !== team) continue
    if (world.kind[id] !== KIND_WORKER && world.kind[id] !== KIND_PILE) continue
    if (world.carryKind[id] === carryKind) total += world.carryAmount[id]
  }
  return total
}

function loadWorker(world: World, id: number, carryKind: number, amount: number): void {
  world.carryKind[id] = carryKind
  world.carryAmount[id] = amount
}

function stepUntil(world: World, pred: () => boolean, maxSteps: number): boolean {
  for (let i = 0; i < maxSteps; i += 1) {
    if (pred()) return true
    world.update(STEP)
  }
  return pred()
}

/** Death check for a worker id: the death pile recycles the corpse's
 *  own id in the same combat pass, so `!entities.has(id)` can stay
 *  false forever — the slot stops being a worker instead. */
function workerGone(world: World, id: number): boolean {
  return !world.entities.has(id) || world.kind[id] !== KIND_WORKER
}

/** Kill a worker through the real combat funnel: a staged enemy melee
 *  with a pre-set attack order and the victim's health floored. */
function stageKill(world: World, victim: number): void {
  world.health[victim] = 1
  const melee = world.spawnUnit(
    'melee',
    TEAM_ENEMY,
    world.positionX[victim] + 0.5,
    world.positionZ[victim],
  ).id
  world.state[melee] = 4 // STATE_ATTACK
  world.targetId[melee] = victim
  world.moving[melee] = 0
  world.cooldown[melee] = 0
}

// ---------------------------------------------------------------------------
// The trip
// ---------------------------------------------------------------------------

suite('militia-townhall: the trip')

test('§a-1 trip, not teleport: the ring calls; nobody is militia before arrival', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  const far = world.spawnUnit('worker', TEAM_PLAYER, 100, 100).id
  loadWorker(world, peasant, CARRY_GOLD, 10)

  const called = world.ringMilitiaBell(TEAM_PLAYER)

  assertEqual(called, 1, 'one peasant in radius is called')
  assertEqual(world.state[peasant], STATE_MUSTER, 'the called peasant is traveling')
  assert(!world.isMilitia(peasant), 'not militia before arrival — he is unarmed')
  assertEqual(world.militiaUntil[peasant], 0, 'the levy clock is NOT stamped at the ring')
  assertEqual(world.carryAmount[peasant], 10, 'the load is still on his back')
  assertEqual(world.state[far], STATE_IDLE, 'a peasant outside the radius is untouched')

  const x0 = world.positionX[peasant]
  stepWorld(world, 30) // 0.5 s of travel (14 units to walk: ~2.8 s)
  assert(world.positionX[peasant] < x0, 'he is walking toward the hall')
  assertEqual(world.state[peasant], STATE_MUSTER, 'still traveling at 0.5 s')
  assert(!world.isMilitia(peasant), 'still unarmed mid-trip')

  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms on arrival')
  assertEqual(world.state[peasant], STATE_IDLE, 'an armed pikeman stands at the hall')
})

test('§a-2/§a-6 deposit on arming: the bank rises by exactly the carried total', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const goldHand = world.spawnUnit('worker', TEAM_PLAYER, 12, 0).id
  const woodHand = world.spawnUnit('worker', TEAM_PLAYER, 0, 12).id
  world.spawnUnit('worker', TEAM_PLAYER, 18, 0) // empty-handed
  world.gold[TEAM_PLAYER] = 200
  world.wood[TEAM_PLAYER] = 100
  loadWorker(world, goldHand, CARRY_GOLD, 10)
  loadWorker(world, woodHand, CARRY_WOOD, 7)
  const goldBefore = totalOf(world, TEAM_PLAYER, CARRY_GOLD)
  const woodBefore = totalOf(world, TEAM_PLAYER, CARRY_WOOD)

  world.ringMilitiaBell(TEAM_PLAYER)

  assertEqual(world.gold[TEAM_PLAYER], 200, 'nothing banked at the ring itself')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile is created at a ring')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), goldBefore, 1e-4, 'gold conserved by the ring')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_WOOD), woodBefore, 1e-4, 'wood conserved by the ring')

  const armed = stepUntil(
    world,
    () => world.isMilitia(goldHand) && world.isMilitia(woodHand),
    1200,
  )
  assert(armed, 'both loaded peasants arm')
  assertEqual(world.gold[TEAM_PLAYER], 210, 'gold banked exactly once on arming (+10)')
  assertEqual(world.wood[TEAM_PLAYER], 107, 'wood banked exactly once on arming (+7)')
  assertEqual(world.carryAmount[goldHand], 0, 'gold hand empty after arming')
  assertEqual(world.carryAmount[woodHand], 0, 'wood hand empty after arming')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'still no piles — loads banked, not dropped')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), goldBefore, 1e-4, 'gold conserved by arming')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_WOOD), woodBefore, 1e-4, 'wood conserved by arming')
})

test('§a-3/§b-2 the levy clock runs from arming: edge peasant and at-hall peasant each serve a full 25 s', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const edge = world.spawnUnit('worker', TEAM_PLAYER, 25, 0).id // radius edge: 19 units to walk
  const near = world.spawnUnit('worker', TEAM_PLAYER, 5, 0).id // inside the arrival ring already
  const ringTime = world.matchTime
  world.ringMilitiaBell(TEAM_PLAYER)

  let nearArmTime = -1
  let edgeArmTime = -1
  for (let i = 0; i < 1200 && (nearArmTime < 0 || edgeArmTime < 0); i += 1) {
    world.update(STEP)
    if (nearArmTime < 0 && world.isMilitia(near)) {
      nearArmTime = world.matchTime
      assertClose(
        world.militiaUntil[near] - world.matchTime,
        MILITIA_DURATION_SEC,
        0.02,
        'at-hall peasant: militiaUntil = his arming time + 25',
      )
    }
    if (edgeArmTime < 0 && world.isMilitia(edge)) {
      edgeArmTime = world.matchTime
      assertClose(
        world.militiaUntil[edge] - world.matchTime,
        MILITIA_DURATION_SEC,
        0.02,
        'edge peasant: militiaUntil = his arming time + 25 (travel is NOT shaved off)',
      )
    }
  }
  assert(nearArmTime > 0, 'at-hall peasant armed')
  assert(edgeArmTime > 0, 'edge peasant armed')
  assert(nearArmTime - ringTime < 0.2, `at-hall stand-up is ~instant (${(nearArmTime - ringTime).toFixed(2)}s)`)
  const edgeTravel = edgeArmTime - ringTime
  assert(
    edgeTravel > 3.6 && edgeTravel < 4.0,
    `radius-edge stand-up ≈ 3.8 s calm (measured ${edgeTravel.toFixed(2)}s)`,
  )
  // Full service, measured from each arming:
  const nearGone = stepUntil(world, () => !world.isMilitia(near), 2400)
  assert(nearGone, 'at-hall levy lapses')
  assertClose(world.matchTime - nearArmTime, MILITIA_DURATION_SEC, 0.1, 'at-hall service was a full 25 s')
  const edgeGone = stepUntil(world, () => !world.isMilitia(edge), 2400)
  assert(edgeGone, 'edge levy lapses')
  assertClose(world.matchTime - edgeArmTime, MILITIA_DURATION_SEC, 0.1, 'edge service was a full 25 s')
})

test('§b-2 winter: the radius-edge peasant is slower to arm and still serves a full 25 s', () => {
  const calm = makeBareWorld()
  calm.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const calmEdge = calm.spawnUnit('worker', TEAM_PLAYER, 25, 0).id
  calm.ringMilitiaBell(TEAM_PLAYER)
  let calmTicks = 0
  while (!calm.isMilitia(calmEdge) && calmTicks < 1200) {
    calm.update(STEP)
    calmTicks += 1
  }

  const winter = makeBareWorld()
  winter.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  winter.season = SEASON_WINTER
  const winterEdge = winter.spawnUnit('worker', TEAM_PLAYER, 25, 0).id
  winter.ringMilitiaBell(TEAM_PLAYER)
  let winterTicks = 0
  while (!winter.isMilitia(winterEdge) && winterTicks < 1200) {
    winter.update(STEP)
    winterTicks += 1
  }

  assert(calm.isMilitia(calmEdge) && winter.isMilitia(winterEdge), 'both peasants arm')
  assert(
    winterTicks > calmTicks * 1.2,
    `winter stand-up (${winterTicks} ticks) is materially slower than calm (${calmTicks})`,
  )
  assertClose(
    winter.militiaUntil[winterEdge] - winter.matchTime,
    MILITIA_DURATION_SEC,
    0.02,
    'winter levy is still a full 25 s from arming',
  )
})

test('§a-5 full cycle: ring → travel → arm → serve → expiry → return → peasant again', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const crew = [
    world.spawnUnit('worker', TEAM_PLAYER, 10, 0).id,
    world.spawnUnit('worker', TEAM_PLAYER, 15, 5).id,
    world.spawnUnit('worker', TEAM_PLAYER, 20, -5).id,
  ]
  world.ringMilitiaBell(TEAM_PLAYER)
  for (const id of crew) assertEqual(world.state[id], STATE_MUSTER, 'every called peasant travels')

  const armed = stepUntil(world, () => crew.every((id) => world.isMilitia(id)), 1200)
  assert(armed, 'the whole crew arms')
  for (const id of crew) assertEqual(world.state[id], STATE_IDLE, 'armed pikemen stand at the hall')

  // Through the expiry: every pikeman must pass through DISARM (or be
  // observed walking home) and end released — nobody stuck as pikeman.
  const sawDisarm = new Set<number>()
  let released = false
  for (let i = 0; i < 3600 && !released; i += 1) {
    world.update(STEP)
    for (const id of crew) if (world.state[id] === STATE_DISARM) sawDisarm.add(id)
    released = crew.every((id) => !world.isBellDuty(id) && world.state[id] === STATE_IDLE)
  }
  assert(released, 'every pikeman is released back to an ordinary peasant')
  assertEqual(sawDisarm.size, crew.length, 'every pikeman traveled home through STATE_DISARM')
  for (const id of crew) {
    assertEqual(world.militiaUntil[id], 0, 'no levy clock dangles after release')
    assert(!world.isMilitia(id), 'nobody is still militia')
  }
})

test('§a-4/§b-2 cooldown is stamped at the ring and refuses re-rings through the whole cycle', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  const ringTime = world.matchTime
  world.ringMilitiaBell(TEAM_PLAYER)
  assertClose(world.militiaCooldown[TEAM_PLAYER], ringTime + 120, 1e-9, 'cooldown = ring time + 120')

  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 're-ring during travel refused')
  assertEqual(world.militiaRefusal(TEAM_PLAYER), 'cooldown', 'refusal mirror agrees during travel')
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'peasant arms')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 're-ring during service refused')
  assertEqual(world.militiaRefusal(TEAM_PLAYER), 'cooldown', 'refusal mirror agrees during service')
  const home = stepUntil(world, () => !world.isBellDuty(peasant), 3600)
  assert(home, 'peasant completes the cycle')
  assertEqual(world.ringMilitiaBell(TEAM_PLAYER), 0, 're-ring during the cooldown tail refused')
})

test('§b-4 a RETURN-state peasant mustered banks exactly once — deposit-on-arming IS his delivery', () => {
  const world = makeBareWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 12, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  // Stage him mid-RETURN: walking the load home when the bell rings.
  world.state[peasant] = 3 // STATE_RETURN
  world.targetId[peasant] = hall
  world.targetX[peasant] = 0
  world.targetZ[peasant] = 0
  world.stopDist[peasant] = 6
  world.moving[peasant] = 1

  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'the bell takes him off his delivery walk')

  let maxBank = 0
  const armed = stepUntil(world, () => {
    maxBank = Math.max(maxBank, world.gold[TEAM_PLAYER])
    return world.isMilitia(peasant)
  }, 1200)
  assert(armed, 'he arms')
  assertEqual(world.gold[TEAM_PLAYER], 210, 'banked exactly 10 — no double-bank, no vanish')
  assertEqual(maxBank, 210, 'the bank never overshot (no double deposit at any tick)')
  assertEqual(world.carryAmount[peasant], 0, 'hands empty')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), 210, 1e-4, 'total conserved')
})

test('§7 a BUILD peasant walks off the site; the site keeps its progress without him', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const site = world.spawnBuilding('barracks', TEAM_PLAYER, 15, 15, false).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 12, 12).id
  world.state[peasant] = STATE_BUILD
  world.targetId[peasant] = site
  world.moving[peasant] = 0
  world.buildProgress[site] = 5

  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[peasant], STATE_MUSTER, 'the bell takes the builder off the site')

  stepWorld(world, 120)
  assertEqual(world.buildProgress[site], 5, 'site progress is the structure’s — untouched in his absence')
  const cycle = stepUntil(world, () => !world.isBellDuty(peasant), 3600)
  assert(cycle, 'the builder completes the bell cycle')
  assertEqual(world.buildProgress[site], 5, 'site still waits, unharmed, after his release')
})

// ---------------------------------------------------------------------------
// The death case
// ---------------------------------------------------------------------------

suite('militia-townhall: the death case')

test('§a-7/§b-4 killed in STATE_MUSTER with a load: the load becomes a pile where he fell', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 30) // mid-trip: ~2.5 units walked
  assertEqual(world.state[peasant], STATE_MUSTER, 'still traveling when the blow lands')
  const deathX = world.positionX[peasant]
  const deathZ = world.positionZ[peasant]

  stageKill(world, peasant)
  const died = stepUntil(world, () => workerGone(world, peasant), 120)
  assert(died, 'the traveler dies through the combat funnel')

  const piles = pilesOf(world, TEAM_PLAYER)
  assertEqual(piles.length, 1, 'exactly one pile from the en-route death')
  const pile = piles[0]
  assertEqual(world.carryKind[pile], CARRY_GOLD, 'pile kind matches the lost load')
  assertEqual(world.carryAmount[pile], 10, 'pile holds the exact load')
  assertClose(world.positionX[pile], deathX, 1.0, 'pile lies where he fell (x)')
  assertClose(world.positionZ[pile], deathZ, 1.0, 'pile lies where he fell (z)')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), 210, 1e-4, 'the load survived its carrier')
})

test('§a-7 killed one tick before arrival still piles; killed after arming does not', () => {
  // Before arrival: 8 from the hall centre — 0.4 s of travel left.
  const before = makeBareWorld()
  before.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const early = before.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
  loadWorker(before, early, CARRY_GOLD, 10)
  before.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(before, 12) // halfway through the short walk, still MUSTER
  assertEqual(before.state[early], STATE_MUSTER, 'not yet armed at the kill')
  stageKill(before, early)
  stepUntil(before, () => workerGone(before, early), 120)
  assertEqual(pilesOf(before, TEAM_PLAYER).length, 1, 'a pre-arming death leaves a pile')

  // After arming: the load was banked at the hall; the pikeman carries nothing.
  const after = makeBareWorld()
  after.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const late = after.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
  after.gold[TEAM_PLAYER] = 200
  loadWorker(after, late, CARRY_GOLD, 10)
  after.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(after, () => after.isMilitia(late), 600), 'he arms')
  assertEqual(after.gold[TEAM_PLAYER], 210, 'his load is banked, not carried')
  stageKill(after, late)
  stepUntil(after, () => workerGone(after, late), 120)
  assertEqual(pilesOf(after, TEAM_PLAYER).length, 0, 'a pikeman’s death spawns NO pile')
  assertEqual(after.gold[TEAM_PLAYER], 210, 'the bank keeps what he delivered')
})

test('§a-7 killed in STATE_DISARM: no pile (the pike is not a resource)', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  const returning = stepUntil(world, () => world.state[peasant] === STATE_DISARM, 3600)
  assert(returning, 'he is on the trip home')
  stageKill(world, peasant)
  stepUntil(world, () => workerGone(world, peasant), 120)
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'a disarmer’s death spawns NO pile')
})

test('§a-7 an ordinary worker death off bell duty behaves exactly as today: no pile, load lost', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  stageKill(world, peasant)
  stepUntil(world, () => workerGone(world, peasant), 120)
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile for an off-duty death')
  assertClose(
    totalOf(world, TEAM_PLAYER, CARRY_GOLD),
    200,
    1e-4,
    'the load is lost with him, exactly as deaths work today',
  )
})

test('§8 two travelers killed side by side leave ONE merged pile', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const a = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
  const b = world.spawnUnit('worker', TEAM_PLAYER, 15, 1).id
  loadWorker(world, a, CARRY_GOLD, 10)
  loadWorker(world, b, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 10)
  stageKill(world, a)
  stageKill(world, b)
  const both = stepUntil(world, () => workerGone(world, a) && workerGone(world, b), 240)
  assert(both, 'both travelers die')
  const piles = pilesOf(world, TEAM_PLAYER)
  assertEqual(piles.length, 1, 'the second death merged into the first pile (within 2.0)')
  assertEqual(world.carryAmount[piles[0]], 20, 'the merged pile holds both loads')
})

// ---------------------------------------------------------------------------
// Interruptions
// ---------------------------------------------------------------------------

suite('militia-townhall: interruptions')

test('§a-9/§b-1 a player move order mid-trip dissolves the duty permanently', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 30)

  orderMove(world, peasant, 40, 40)
  assertEqual(world.state[peasant], STATE_MOVE, 'the player order wins immediately')
  assertEqual(world.harvestKind[peasant], 3, 'the move order’s own HARVEST_OFF applies — the bell added nothing')

  let armed = false
  let carryMidWalk = -1
  for (let i = 0; i < 2400; i += 1) {
    world.update(STEP)
    if (world.isMilitia(peasant)) armed = true
    assert(world.state[peasant] !== STATE_MUSTER, 'the bell never re-asserts itself over him')
    if (i === 60) carryMidWalk = world.carryAmount[peasant]
  }
  assert(!armed, 'he never arms — the duty is dissolved, not deferred')
  assertEqual(world.militiaUntil[peasant], 0, 'no levy clock was ever stamped')
  assertEqual(carryMidWalk, 10, 'his load stayed on his back while he obeyed the move order')
  // Under ordinary worker rules the FSM then delivers the load itself:
  // arrival → RETURN → deposit. Nothing about the bell lingers.
  assertEqual(world.gold[TEAM_PLAYER], 210, 'the ordinary FSM delivered his load in the end')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile — nothing died, nothing dropped')
})

test('§a-9/§b-1 a player gather order mid-trip dissolves the duty; the FSM delivers his load', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  world.spawnResource('gold', 30, 30)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 30)

  orderGather(world, peasant)
  let armed = false
  let banked = false
  for (let i = 0; i < 3600 && !banked; i += 1) {
    world.update(STEP)
    if (world.isMilitia(peasant)) armed = true
    if (world.gold[TEAM_PLAYER] === 210) banked = true
  }
  assert(!armed, 'he never arms after the gather order')
  assert(banked, 'his carried load reaches the bank through the ordinary RETURN path')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile — nothing died, nothing dropped')
})

test('§a-9/§b-1 a player order mid-DISARM abandons the return safely', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  assert(stepUntil(world, () => world.state[peasant] === STATE_DISARM, 3600), 'he starts home')

  orderMove(world, peasant, -40, -40)
  stepWorld(world, 600)
  assertEqual(world.militiaUntil[peasant], 0, 'nothing dangles: the clock was already cleared')
  assert(world.state[peasant] !== STATE_DISARM, 'the return is abandoned, not resumed')
  assert(!world.isBellDuty(peasant), 'he is an ordinary peasant under his own orders')
})

test('§a-5/§b-5 the expiry yank set: on-duty states ordered home, re-tasked states cleared in place', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const tree = world.spawnResource('wood', 30, 0).id
  const site = world.spawnBuilding('barracks', TEAM_PLAYER, 20, 20, false).id
  const enemy = world.spawnUnit('melee', TEAM_ENEMY, 60, 60).id
  const crew: Record<string, number> = {}
  for (const name of ['idle', 'attack', 'hold', 'move', 'gather', 'build']) {
    crew[name] = world.spawnUnit('worker', TEAM_PLAYER, 8, 0).id
  }
  world.ringMilitiaBell(TEAM_PLAYER)
  const ids = Object.values(crew)
  assert(stepUntil(world, () => ids.every((id) => world.isMilitia(id)), 900), 'the whole crew arms')

  // Stage each pikeman into a different state, then lapse every clock.
  world.state[crew.attack] = 4 // STATE_ATTACK on a distant staged target
  world.targetId[crew.attack] = enemy
  world.state[crew.hold] = 8 // STATE_HOLD
  world.moving[crew.hold] = 0
  orderMove(world, crew.move, 50, 50) // re-tasked by a direct order mid-levy
  world.state[crew.gather] = STATE_GATHER // re-tasked by the economy
  world.targetId[crew.gather] = tree
  world.state[crew.build] = STATE_BUILD
  world.targetId[crew.build] = site
  for (const id of ids) world.militiaUntil[id] = world.matchTime + STEP

  // The return order lands on the lapse tick; an armed-at-the-edge
  // pikeman's DISARM can complete within a tick or two, so sample the
  // window rather than assert a resting state.
  const sawDisarm = new Set<string>()
  for (let i = 0; i < 4; i += 1) {
    world.update(STEP)
    for (const name of ['idle', 'attack', 'hold', 'move', 'gather', 'build']) {
      if (world.state[crew[name]] === STATE_DISARM) sawDisarm.add(name)
    }
  }

  for (const name of ['idle', 'attack', 'hold']) {
    assert(sawDisarm.has(name), `${name}: on-duty pikeman is ordered home (STATE_DISARM observed)`)
    assertEqual(world.militiaUntil[crew[name]], 0, `${name}: clock cleared at the order`)
  }
  for (const name of ['move', 'gather', 'build']) {
    assert(!sawDisarm.has(name), `${name}: re-tasked pikeman is never yanked`)
    assertEqual(world.militiaUntil[crew[name]], 0, `${name}: clock cleared in place`)
  }
  assertEqual(world.state[crew.move], STATE_MOVE, 'the move order still owns its pikeman')
  assertEqual(world.state[crew.gather], STATE_GATHER, 'the gather order still owns its pikeman')
  assertEqual(world.state[crew.build], STATE_BUILD, 'the build order still owns its pikeman')
})

test('§b-5 expiry with no hall anywhere: release in place, nothing dangles', () => {
  const world = makeBareWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 10, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  world.removeEntityById(hall)
  world.militiaUntil[peasant] = world.matchTime + STEP
  stepWorld(world, 3)
  assertEqual(world.state[peasant], STATE_IDLE, 'released in place as an ordinary peasant')
  assertEqual(world.militiaUntil[peasant], 0, 'clock cleared')
  assert(!world.isBellDuty(peasant), 'no duty dangles')
})

// ---------------------------------------------------------------------------
// Hall loss
// ---------------------------------------------------------------------------

suite('militia-townhall: hall loss')

test('§a-10/§b-3 muster hall destroyed mid-trip: the trip re-resolves to the other finished hall', () => {
  const world = makeBareWorld()
  const hallA = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const hallB = world.spawnBuilding('hall', TEAM_PLAYER, 40, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 10, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.targetId[peasant], hallA, 'the ring chose the first hall in entity order')
  stepWorld(world, 30)

  world.removeEntityById(hallA)
  const retargeted = stepUntil(world, () => world.targetId[peasant] === hallB, 120)
  assert(retargeted, 'the trip re-resolves to the surviving finished hall')
  const armed = stepUntil(world, () => world.isMilitia(peasant), 1200)
  assert(armed, 'he arms at the fallback hall')
  assertEqual(world.gold[TEAM_PLAYER], 210, 'his load banks at the fallback hall')
  const d = Math.hypot(world.positionX[peasant] - 40, world.positionZ[peasant])
  assert(d < 8, `he stands at the fallback hall’s edge (d=${d.toFixed(1)})`)
})

test('§a-10/§b-3 all halls destroyed mid-trip: the muster dissolves with the load intact', () => {
  const world = makeBareWorld()
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 30)

  world.removeEntityById(hall)
  const dissolved = stepUntil(world, () => world.state[peasant] !== STATE_MUSTER, 120)
  assert(dissolved, 'the muster dissolves — he does not walk to a ruin')
  stepWorld(world, 240)
  assertEqual(world.state[peasant], STATE_IDLE, 'he waits as an ordinary loaded worker')
  assertEqual(world.carryAmount[peasant], 10, 'the load never left his hands')
  assert(!world.isBellDuty(peasant), 'no duty dangles')

  // When a hall stands again, the ordinary FSM lands the load.
  world.spawnBuilding('hall', TEAM_PLAYER, 5, 0, true)
  const banked = stepUntil(world, () => world.gold[TEAM_PLAYER] === 210, 1200)
  assert(banked, 'the load deposits once a hall stands')
})

test('§b-6 destination destroyed and its id recycled as a tree mid-trip: the trip re-resolves, never walks to the tree', () => {
  const world = makeBareWorld()
  const hallA = world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true).id
  const hallB = world.spawnBuilding('hall', TEAM_PLAYER, 40, 0, true).id
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 10, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.targetId[peasant], hallA, 'traveling to hall A')
  stepWorld(world, 30)

  world.removeEntityById(hallA)
  const tree = world.spawnResource('wood', 60, 60).id
  assertEqual(tree, hallA, 'staging check: the tree recycled the dead hall’s id')
  assertEqual(world.kind[tree], KIND_TREE, 'the dead hall’s id now names a tree')
  // Two lines of defense, both exercised by what follows: removeEntity
  // scrubs targetId at removal (no dangling reference survives), and
  // retargetTrip validates kind/team — never mere existence — before
  // honoring any destination id it is handed.
  const retargeted = stepUntil(world, () => world.targetId[peasant] === hallB, 120)
  assert(retargeted, 'the trip re-resolves to hall B')
  let maxX = -Infinity
  const armed = stepUntil(world, () => {
    maxX = Math.max(maxX, world.positionX[peasant])
    return world.isMilitia(peasant)
  }, 1200)
  assert(armed, 'he arms at hall B')
  assert(maxX < 40, 'he never walked toward the tree at (60,60)')
})

// ---------------------------------------------------------------------------
// The AI settlement
// ---------------------------------------------------------------------------

suite('militia-townhall: the AI settlement')

test('§a-8 isBellDuty covers exactly the trip, the stand, and the return', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  assert(!world.isBellDuty(peasant), 'an ordinary worker is not on bell duty')
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(world.isBellDuty(peasant), 'a traveler is on bell duty')
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  assert(world.isBellDuty(peasant), 'a serving pikeman is on bell duty')
  assert(stepUntil(world, () => world.state[peasant] === STATE_DISARM, 3600), 'he starts home')
  assert(world.isBellDuty(peasant), 'a disarmer is on bell duty')
  assert(stepUntil(world, () => !world.isBellDuty(peasant), 1200), 'he is released')
})

test('§a-8/§b-1 a raid on the wood line: AI evacuation and assignment never touch the traveler', () => {
  const world = makeBareWorld('human', 'orc', true)
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const traveler = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.health[traveler] = 100000 // staging: the test is about ORDERS, not survival
  loadWorker(world, traveler, CARRY_GOLD, 10)
  // A raider 6 units from the traveler: inside FLEE_TRIGGER (32), inside
  // the hall's defense radius (28 from origin? no — 26 from the traveler
  // means ~26+ from the hall along +x) and visible through the
  // traveler's own sight — precisely the bell's trigger context.
  world.spawnUnit('melee', TEAM_ENEMY, 26, 0)
  world.ringMilitiaBell(TEAM_PLAYER)

  let sawMove = false
  let armed = false
  for (let i = 0; i < 600 && !armed; i += 1) {
    world.update(STEP)
    if (!world.entities.has(traveler)) break
    if (world.state[traveler] === STATE_MOVE) sawMove = true
    if (world.isMilitia(traveler)) armed = true
  }
  assert(armed, 'the traveler completes his trip and arms under fire')
  assert(!sawMove, 'no AI pass ever re-ordered the traveler (no STATE_MOVE sightings)')
})

test('§a-8/§b-1 build resumption skips bell-duty workers — and takes a free worker (control)', () => {
  // Bell-duty world: the only worker is mid-trip.
  const duty = makeBareWorld('human', 'orc', true)
  duty.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const dutySite = duty.spawnBuilding('barracks', TEAM_PLAYER, 15, 15, false).id
  const traveler = duty.spawnUnit('worker', TEAM_PLAYER, 12, 0).id
  duty.ringMilitiaBell(TEAM_PLAYER)
  let seized = false
  for (let i = 0; i < 300; i += 1) {
    duty.update(STEP)
    if (duty.state[traveler] === STATE_BUILD) seized = true
  }
  assert(!seized, 'resumeStalledBuilds never seized the traveler')
  assertEqual(buildersOnSite(duty, dutySite), 0, 'the stalled site stays uncrewed rather than steal the muster')

  // Control world: the same site, an ordinary free worker — he IS taken.
  const free = makeBareWorld('human', 'orc', true)
  free.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const freeSite = free.spawnBuilding('barracks', TEAM_PLAYER, 15, 15, false).id
  const worker = free.spawnUnit('worker', TEAM_PLAYER, 12, 0).id
  let taken = false
  for (let i = 0; i < 300 && !taken; i += 1) {
    free.update(STEP)
    if (free.state[worker] === STATE_BUILD && free.targetId[worker] === freeSite) taken = true
  }
  assert(taken, 'control: the free worker is resumed onto the stalled site')
})

test('§b-8 the AI’s own scout inside the radius is called, arms, and is never stranded or doubled', () => {
  const world = makeBareWorld('human', 'orc', true)
  // Real-match geography: the AI's scout route is the mirror of its
  // own hall position, so the hall must sit off-origin (at (0,0) the
  // route would target the base itself and no march ever happens).
  world.spawnBuilding('hall', TEAM_PLAYER, -40, -40, true)
  world.spawnBuilding('hall', TEAM_ENEMY, 40, 40, true)
  const crew = [
    world.spawnUnit('worker', TEAM_PLAYER, -36, -40).id,
    world.spawnUnit('worker', TEAM_PLAYER, -40, -36).id,
    world.spawnUnit('worker', TEAM_PLAYER, -44, -40).id,
    world.spawnUnit('worker', TEAM_PLAYER, -40, -44).id,
  ]
  // Let the AI pick its scout: the scout is the worker marching away
  // from base under a move order while the others stay near the hall.
  // (New scouts only go out in the first 3 minutes — gameTime ≤ 180.)
  let scout = -1
  for (let i = 0; i < 60 * 170 && scout < 0; i += 1) {
    world.update(STEP)
    for (const id of crew) {
      if (world.state[id] !== STATE_MOVE) continue
      const d = Math.hypot(world.positionX[id] + 40, world.positionZ[id] + 40)
      const td = Math.hypot(world.targetX[id] + 40, world.targetZ[id] + 40)
      if (d < 24 && td > 20) scout = id
    }
  }
  assert(scout >= 0, 'the AI sent a scout (staging precondition)')

  world.ringMilitiaBell(TEAM_PLAYER)
  assertEqual(world.state[scout], STATE_MUSTER, 'the scout is called like anyone')

  let scoutArmed = false
  let maxSimultaneousMovers = 0
  for (let i = 0; i < 60 * 90; i += 1) {
    world.update(STEP)
    if (world.isMilitia(scout)) scoutArmed = true
    let movers = 0
    for (const id of crew) if (world.entities.has(id) && world.state[id] === STATE_MOVE) movers += 1
    if (i > 60 * 40) maxSimultaneousMovers = Math.max(maxSimultaneousMovers, movers)
  }
  assert(scoutArmed, 'the called scout armed at the hall')
  assert(!world.isBellDuty(scout), 'the scout is never stranded in a trip state')
  assert(
    maxSimultaneousMovers <= 1,
    `the scout is never doubled (max simultaneous movers after the cycle: ${maxSimultaneousMovers})`,
  )
})

// ---------------------------------------------------------------------------
// Save/load seams
// ---------------------------------------------------------------------------

suite('militia-townhall: save/load seams')

test('§a-11 mid-trip save → load → the trip completes and banks exactly; SAVE_VERSION stays 1', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, peasant, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 60) // 1 s into a 2.8 s trip
  assertEqual(world.state[peasant], STATE_MUSTER, 'mid-trip at save time')

  const save = serializeWorld(world, 0, [])
  assertEqual(save.version, 1, 'SAVE_VERSION stays 1')
  const restored = makeBareWorld()
  deserializeWorld(restored, save)

  assertEqual(restored.state[peasant], STATE_MUSTER, 'the trip state round-trips')
  assertEqual(restored.carryAmount[peasant], 10, 'the load round-trips on his back')
  const armed = stepUntil(restored, () => restored.isMilitia(peasant), 1200)
  assert(armed, 'the loaded world resumes and completes the trip')
  assertEqual(restored.gold[TEAM_PLAYER], 210, 'the load banks exactly in the loaded world')
})

test('§a-11 mid-levy save → remaining service is exact to the tick; the return completes after load', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 10, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  stepWorld(world, 600) // 10 s into the 25 s levy
  const untilAtSave = world.militiaUntil[peasant]
  const timeAtSave = world.matchTime

  const save = serializeWorld(world, 0, [])
  const restored = makeBareWorld()
  deserializeWorld(restored, save)
  assertClose(restored.militiaUntil[peasant], untilAtSave, 1e-6, 'militiaUntil round-trips exactly')
  assertClose(restored.matchTime, timeAtSave, 1e-6, 'matchTime round-trips exactly')
  assert(restored.isMilitia(peasant), 'still serving after load')

  const lapsed = stepUntil(restored, () => !restored.isMilitia(peasant), 1800)
  assert(lapsed, 'the levy lapses in the loaded world')
  assertClose(restored.matchTime - timeAtSave, 15, 0.1, 'the remaining service was exactly the saved 15 s')
  const home = stepUntil(restored, () => !restored.isBellDuty(peasant), 1200)
  assert(home, 'the return completes in the loaded world')
})

test('§a-11 mid-return save → the release completes after load', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.ringMilitiaBell(TEAM_PLAYER)
  assert(stepUntil(world, () => world.isMilitia(peasant), 600), 'he arms')
  assert(stepUntil(world, () => world.state[peasant] === STATE_DISARM, 3600), 'he starts home')

  const save = serializeWorld(world, 0, [])
  const restored = makeBareWorld()
  deserializeWorld(restored, save)
  assertEqual(restored.state[peasant], STATE_DISARM, 'the return state round-trips')
  const home = stepUntil(restored, () => !restored.isBellDuty(peasant), 1200)
  assert(home, 'the release completes in the loaded world')
  assertEqual(restored.state[peasant], STATE_IDLE, 'an ordinary peasant again')
})

// ---------------------------------------------------------------------------
// Determinism — the §11 scripted scenario
// ---------------------------------------------------------------------------

suite('militia-townhall: determinism scenario')

test('§a-12 scripted: ring → travel → en-route kill → pile → survivors serve → return → pickup → deposit', () => {
  const runScenario = () => {
    const world = makeBareWorld()
    world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
    const doomed = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
    const survivor = world.spawnUnit('worker', TEAM_PLAYER, 10, 5).id
    const empty = world.spawnUnit('worker', TEAM_PLAYER, 8, -5).id
    world.gold[TEAM_PLAYER] = 200
    world.health[doomed] = 5 // staging: the scripted blow kills in one swing
    loadWorker(world, doomed, CARRY_GOLD, 10)
    loadWorker(world, survivor, CARRY_GOLD, 10)
    world.ringMilitiaBell(TEAM_PLAYER)

    const hashes: string[] = []
    const seen = { muster: false, pile: false, armed: false, disarm: false }
    let killer = -1
    for (let tick = 0; tick < 7200; tick += 1) {
      if (tick === 30) {
        // The scripted kill, placed on the doomed traveler's path.
        killer = world.spawnUnit('melee', TEAM_ENEMY, world.positionX[doomed] - 1.5, 0.3).id
        world.state[killer] = 4 // STATE_ATTACK
        world.targetId[killer] = doomed
        world.cooldown[killer] = 0
      }
      if (tick === 34) {
        // Staging cleanup: the killer's part is done; remove him so the
        // scenario measures the bell machine, not a hall siege. Both
        // runs perform the identical script, so parity is unaffected.
        if (killer >= 0 && world.entities.has(killer)) world.removeEntityById(killer)
      }
      if (tick === 3600) {
        // Command layer: send the released survivor over the pile.
        const pile = pilesOf(world, TEAM_PLAYER)[0]
        if (pile !== undefined) {
          orderMove(world, survivor, world.positionX[pile], world.positionZ[pile])
        }
      }
      world.update(STEP)
      if (world.state[survivor] === STATE_MUSTER || world.state[empty] === STATE_MUSTER) seen.muster = true
      if (pilesOf(world, TEAM_PLAYER).length > 0) seen.pile = true
      if (world.isMilitia(survivor)) seen.armed = true
      if (world.state[survivor] === STATE_DISARM) seen.disarm = true
      if ((tick + 1) % 30 === 0) hashes.push(hashToHex(hashWorldState(world)))
    }
    return {
      hashes,
      seen,
      bank: world.gold[TEAM_PLAYER],
      pilesLeft: pilesOf(world, TEAM_PLAYER).length,
      doomedGone: workerGone(world, doomed),
      survivorIdle: world.state[survivor] === STATE_IDLE && !world.isBellDuty(survivor),
    }
  }

  const a = runScenario()
  // The scenario must EXERCISE the whole machine, or parity proves nothing.
  assert(a.seen.muster, 'scenario window contains the trip')
  assert(a.seen.pile, 'scenario window contains the en-route death pile')
  assert(a.seen.armed, 'scenario window contains armed service')
  assert(a.seen.disarm, 'scenario window contains the return')
  assert(a.doomedGone, 'the scripted kill landed')
  assertEqual(a.bank, 220, 'bank ends at 200 + 10 (survivor’s arming) + 10 (recovered pile)')
  assertEqual(a.pilesLeft, 0, 'the pile was recovered and deposited')
  assert(a.survivorIdle, 'the survivor ends as an ordinary peasant')

  const b = runScenario()
  assertEqual(a.hashes.length, b.hashes.length, 'same number of hash checkpoints')
  for (let i = 0; i < a.hashes.length; i += 1) {
    assertEqual(a.hashes[i], b.hashes[i], `hash mismatch at checkpoint ${i} (tick ${(i + 1) * 30})`)
  }
})

// ---------------------------------------------------------------------------
// Surfaces — order text and the selection sweep
// ---------------------------------------------------------------------------

suite('militia-townhall: surfaces')

test('§a-13 both new states have real current-order text inside the 16-char ceiling', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const peasant = world.spawnUnit('worker', TEAM_PLAYER, 20, 0).id
  world.state[peasant] = STATE_MUSTER
  const musterText = unitStateText(world, peasant)
  assertEqual(musterText, 'Mustering', 'a traveler reads as mustering')
  world.state[peasant] = STATE_DISARM
  const disarmText = unitStateText(world, peasant)
  assertEqual(disarmText, 'Handing in pike', 'a disarmer reads as handing in his pike')
  assert(musterText.length <= 16 && disarmText.length <= 16, 'both fit the card’s 16-char ceiling')
  assert(musterText !== '?' && disarmText !== '?', 'no placeholder text')
  // The serving pikeman keeps his existing line.
  world.state[peasant] = STATE_IDLE
  world.militiaUntil[peasant] = world.matchTime + 25
  assertEqual(unitStateText(world, peasant), 'On militia duty', 'armed service text unchanged')
})

interface MockRenderer {
  selection: number[]
  setSelection(sel: number[]): void
  setSelectionBox(box: unknown): void
  screenToWorld(sx: number, sy: number): { x: number; z: number }
  getZoom(): number
  getCssSize(): { w: number; h: number }
  pan(): void
  pingMove(): void
  pingAttack(): void
  centerOn(): void
}

function selectionRig() {
  const world = new World()
  world.factionOfTeam = ['human' as never, 'orc' as never]
  world.spawnBuilding('hall', TEAM_PLAYER, -40, -40, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 0, 0).id
  const worker2 = world.spawnUnit('worker', TEAM_PLAYER, 120, 120).id
  const ownPile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 100, 100).id
  const enemyPile = world.spawnPile(TEAM_ENEMY, CARRY_GOLD, 10, 150, 150).id
  const renderer: MockRenderer = {
    selection: [],
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
    getCssSize() {
      return { w: 400, h: 400 }
    },
    pan() {},
    pingMove() {},
    pingAttack() {},
    centerOn() {},
  }
  const input = new InputControllerImpl()
  const internals = input as unknown as {
    world: unknown
    renderer: unknown
    selected: number[]
    tapSelect(sx: number, sy: number, now?: number): void
    boxSelect(x0: number, y0: number, x1: number, y1: number): void
    onDown(e: unknown): void
    onUp(e: unknown): void
  }
  internals.world = world
  internals.renderer = renderer
  // entityAt reads the spatial hash, which only world.update builds.
  // No systems are registered in this rig, so one update changes
  // nothing but the hash (and matchTime).
  world.update(STEP)
  return { world, renderer, input, internals, worker, worker2, ownPile, enemyPile }
}

test('§a-13/§b-9 selection sweep: no gesture ever puts a pile in the selection', () => {
  const { world, input, internals, worker, worker2, ownPile, enemyPile } = selectionRig()
  const sel = () => input.getSelected()

  // Control: the rig selects real things.
  internals.tapSelect(0, 0, 1000)
  assertEqual(sel().length, 1, 'control: a tap selects the worker')
  assertEqual(sel()[0], worker, 'control: the worker is selected')

  // Tap on an own pile, nothing selected: selects nothing.
  internals.selected = []
  internals.tapSelect(100, 100, 2000)
  assertEqual(sel().length, 0, 'tap on an own pile selects nothing')
  assert(!sel().includes(ownPile), 'the own pile is not in the selection')

  // Tap on an enemy pile, nothing selected: no info-selection either.
  internals.tapSelect(150, 150, 3000)
  assertEqual(sel().length, 0, 'tap on an enemy pile selects nothing')
  assert(!sel().includes(enemyPile), 'the enemy pile is not in the selection')

  // Tap on a pile WITH units selected: the tap becomes a ground order
  // (the recovery gesture — walk a worker over the pile), and the
  // selection still contains no pile.
  internals.selected = [worker]
  internals.tapSelect(100, 100, 4000)
  assertEqual(world.state[worker], STATE_MOVE, 'the selected worker is ordered onto the pile’s spot')
  assert(!sel().includes(ownPile), 'ordering onto a pile does not select it')

  // Marquee over a pile and a worker: only the worker.
  internals.boxSelect(90, 90, 160, 160)
  assert(sel().includes(worker2), 'marquee takes the worker in the box')
  assert(!sel().includes(ownPile) && !sel().includes(enemyPile), 'marquee never takes a pile')

  // Double-tap on a pile: no select-all-of-kind, no selection.
  internals.selected = []
  internals.tapSelect(100, 100, 5000)
  internals.tapSelect(100, 100, 5100)
  assertEqual(sel().length, 0, 'double-tap on a pile selects nothing')

  // Long-press on a pile (press, hold past LONG_PRESS_MS, release).
  const ev = (x: number, y: number, t: number) => ({
    pointerId: 1,
    offsetX: x,
    offsetY: y,
    button: 0,
    pointerType: 'touch',
    timeStamp: t,
  })
  internals.selected = []
  internals.onDown(ev(100, 100, 0))
  internals.onUp(ev(100, 100, 600))
  assertEqual(sel().length, 0, 'long-press on a pile selects nothing')

  // Idle Workers: genuinely idle workers are taken; a pile, a busy
  // traveler, and the move-ordered worker from the smart-order step
  // above are not. (worker2 was marquee-selected but never ordered,
  // so he is still idle; `worker` is under a move order.)
  const mustering = world.spawnUnit('worker', TEAM_PLAYER, 50, 50).id
  world.state[mustering] = STATE_MUSTER
  const idleWorker = world.spawnUnit('worker', TEAM_PLAYER, 200, 0).id
  input.selectIdleWorkers()
  assert(sel().includes(idleWorker), 'idle-workers takes the fresh idle worker')
  assert(sel().includes(worker2), 'idle-workers takes the other idle worker')
  assert(!sel().includes(worker), 'idle-workers skips the worker under a move order')
  assert(!sel().includes(ownPile), 'idle-workers never takes a pile')
  assert(!sel().includes(mustering), 'idle-workers leaves the traveler on his trip')

  // Quick-select bar: piles are never listed as an owned building kind.
  const kinds = input.getOwnedBuildingKinds()
  assert(!kinds.some((k) => k.kind === KIND_PILE), 'the quick-select bar never lists kind 14')
  assertEqual(world.kind[ownPile], KIND_PILE, 'staging check: the pile exists throughout')
})

test('§b-9 selectBuilding is never offered kind 14 by the quick-select bar (kinds list is exhaustive)', () => {
  const { input } = selectionRig()
  const kinds = input.getOwnedBuildingKinds().map((k) => k.kind)
  for (const kind of kinds) {
    assert(kind !== KIND_PILE, 'no pile kind in the bar')
    assert(
      kind === KIND_HALL || kind === 4 || kind === 5 || kind === 6 || kind === 12 || kind === 13,
      `bar kind ${kind} is a real building kind`,
    )
  }
})
