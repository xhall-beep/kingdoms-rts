/**
 * Militia pile tests (Montz's decisions 2026-11-06; Anchor design
 * notes anchor-militia-pile-2026-11-06.md and
 * anchor-militia-townhall-2026-11-06.md).
 *
 * The pile (KIND_PILE) is the retrievable ground form of a worker's
 * carried load. Since the town-hall redesign (15:37 EST, superseding
 * the ring-drop reading), a load leaves a worker's hands exactly two
 * ways: it BANKS when he arms at the hall (the normal bell path — no
 * pile), or it drops as a pile where he falls when he is killed in
 * STATE_MUSTER carrying it (the death case). The pile machinery
 * properties — conservation, merge, cap, pickup discipline, save/
 * load, determinism, isolation — are pinned here; the trip itself is
 * pinned in militia-townhall.test.ts. Audit item 7 / probe P4 (10
 * gold carried → bank unchanged, load gone) is closed by the trip:
 * the load now banks on arming.
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  CARRY_GOLD,
  CARRY_NONE,
  CARRY_WOOD,
  KIND_PILE,
  KIND_WORKER,
  PILE_MAX_PER_TEAM_KIND,
  STATE_ATTACK,
  STATE_GATHER,
  STATE_IDLE,
  STATE_MUSTER,
} from '../core/World.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { hashWorldState, hashToHex } from '../net/hash.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual, assertClose } from './harness.ts'

suite('militia-pile: ground piles')

/** Production system order (tests/setup.ts) on a bare, unseeded world. */
function makeBareWorld(factionA = 'human', factionB = 'human'): World {
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
  world.registerSystem(new MovementSystemImpl())
  return world
}

/** All live piles of a team (optionally of one carry kind), id order. */
function pilesOf(world: World, team: number, carryKind?: number): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_PILE) continue
    if (world.team[id] !== team) continue
    if (carryKind !== undefined && world.carryKind[id] !== carryKind) continue
    out.push(id)
  }
  return out.sort((a, b) => a - b)
}

/**
 * The §4 conservation total for one team + kind:
 * banked + Σ carried by workers + Σ piled. Legitimate sources/sinks
 * (node extraction, spending) never occur in these staged worlds, so
 * the total must be invariant across rings, pickups, merges, deposits.
 */
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
  world.state[melee] = STATE_ATTACK
  world.targetId[melee] = victim
  world.moving[melee] = 0
  world.cooldown[melee] = 0
}

// ---- §4 case 1: P4 closed by the trip ----------------------------------

test('P4 closed by the trip: a ring drops nothing; the load banks on arming', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, worker, CARRY_GOLD, 10)
  const before = totalOf(world, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(before, 210, 'staged total is bank 200 + carried 10')

  const called = world.ringMilitiaBell(TEAM_PLAYER)

  assertEqual(called, 1, 'the loaded peasant is called')
  assertEqual(world.state[worker], STATE_MUSTER, 'he is traveling, not converted in place')
  assertEqual(world.carryAmount[worker], 10, 'the load is still on his back — the ring drops nothing')
  assertEqual(world.gold[TEAM_PLAYER], 200, 'bank unchanged at the ring')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile is created at a ring')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), before, 1e-4, 'total conserved by the ring')

  const armed = stepUntil(world, () => world.isMilitia(worker), 600)
  assert(armed, 'he arms at the hall')
  assertEqual(world.gold[TEAM_PLAYER], 210, 'the load banked on arming — P4’s vanish is gone')
  assertEqual(world.carryAmount[worker], 0, 'hands empty after the deposit')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'still no pile — the load banked, not dropped')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), before, 1e-4, 'total conserved by arming')
})

// ---- §4 case 2: full cycle ---------------------------------------------

test('full cycle: load banks on arming; a pile at the stand survives it untouched and is recovered after release', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  world.gold[TEAM_PLAYER] = 200
  loadWorker(world, worker, CARRY_GOLD, 10)
  world.ringMilitiaBell(TEAM_PLAYER)
  const armed = stepUntil(world, () => world.isMilitia(worker), 600)
  assert(armed, 'he arms at the hall')
  assertEqual(world.gold[TEAM_PLAYER], 210, 'his own load banked on arming')

  // A second load lies piled at his stand position (a fallen
  // traveler's, say). While isMilitia holds he must not re-take it:
  // no self-undo of the muster.
  const pile = world.spawnPile(
    TEAM_PLAYER,
    CARRY_GOLD,
    10,
    world.positionX[worker],
    world.positionZ[worker],
  ).id
  stepWorld(world, 750) // 12.5 s into the stand
  assert(world.isMilitia(worker), 'still serving mid-stand')
  assertEqual(world.carryAmount[pile], 10, 'pile untouched during the stand')
  assertEqual(world.carryAmount[worker], 0, 'the pikeman has not re-taken the pile')

  // After release he is an ordinary worker standing on the pile: the
  // contact pickup takes it and the FSM deposits it, no order needed.
  const deposited = stepUntil(world, () => world.gold[TEAM_PLAYER] === 220, 3600)
  assert(deposited, 'the recovered load reaches the bank after release')
  assertEqual(world.carryAmount[worker], 0, 'worker empty after deposit')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'no pile remains')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), 220, 1e-4, 'total conserved across the cycle')
})

// ---- §4 case 3: partial pickup ------------------------------------------

test('partial pickup: transfer is capped at free capacity, exact remainder stays', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const pile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 3, 3).id
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 3, 3).id
  loadWorker(world, worker, CARRY_GOLD, 4) // carryMax 10 → 6 free
  const before = totalOf(world, TEAM_PLAYER, CARRY_GOLD)

  world.update(STEP)

  assertEqual(world.carryAmount[worker], 10, 'worker topped up to full')
  assert(world.entities.has(pile), 'pile survives a partial drain')
  assertEqual(world.carryAmount[pile], 4, 'pile keeps the exact remainder (10 − 6)')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), before, 1e-4, 'total conserved by pickup')
})

// ---- §4 case 4: merge (death path) ----------------------------------------

test('merge: two loaded travelers killed side by side leave ONE pile with the summed load', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const a = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
  const b = world.spawnUnit('worker', TEAM_PLAYER, 15, 1).id
  loadWorker(world, a, CARRY_GOLD, 10)
  loadWorker(world, b, CARRY_GOLD, 10)
  const before = totalOf(world, TEAM_PLAYER, CARRY_GOLD)

  world.ringMilitiaBell(TEAM_PLAYER)
  stepWorld(world, 10) // both mid-trip, still ~1.0 apart
  stageKill(world, a)
  stageKill(world, b)
  const both = stepUntil(world, () => workerGone(world, a) && workerGone(world, b), 240)
  assert(both, 'both travelers die through the combat funnel')

  const piles = pilesOf(world, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(piles.length, 1, 'the second death-drop merged into the first pile')
  assertEqual(world.carryAmount[piles[0]], 20, 'merged pile holds both loads')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), before, 1e-4, 'total conserved by merge')
})

// ---- §4 case 5: mixed crew ------------------------------------------------

test('mixed crew: the ring drops nothing; each load banks on arming, kinds kept separate', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const goldHand = world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id
  const woodHand = world.spawnUnit('worker', TEAM_PLAYER, 12, 5).id
  const emptyHand = world.spawnUnit('worker', TEAM_PLAYER, 18, 5).id
  loadWorker(world, goldHand, CARRY_GOLD, 10)
  loadWorker(world, woodHand, CARRY_WOOD, 7)
  const goldBefore = totalOf(world, TEAM_PLAYER, CARRY_GOLD)
  const woodBefore = totalOf(world, TEAM_PLAYER, CARRY_WOOD)

  const called = world.ringMilitiaBell(TEAM_PLAYER)

  assertEqual(called, 3, 'all three peasants are called')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'the ring creates no piles — loaded or not')
  assertEqual(world.carryAmount[goldHand], 10, 'gold load still carried')
  assertEqual(world.carryAmount[woodHand], 7, 'wood load still carried')

  const armed = stepUntil(
    world,
    () => world.isMilitia(goldHand) && world.isMilitia(woodHand) && world.isMilitia(emptyHand),
    900,
  )
  assert(armed, 'the whole crew arms')
  assertEqual(world.gold[TEAM_PLAYER], 10, 'gold banked exactly once')
  assertEqual(world.wood[TEAM_PLAYER], 7, 'wood banked exactly once — kinds never cross')
  assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, 'arming created no piles either')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), goldBefore, 1e-4, 'gold total conserved')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_WOOD), woodBefore, 1e-4, 'wood total conserved')
})

// ---- §4 case 6: soak --------------------------------------------------------

test('soak: 20 ring/arm/release cycles conserve the total after every operation', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const crew = [
    world.spawnUnit('worker', TEAM_PLAYER, 5, 5).id,
    world.spawnUnit('worker', TEAM_PLAYER, 7, 5).id,
    world.spawnUnit('worker', TEAM_PLAYER, 5, 7).id,
  ]
  world.gold[TEAM_PLAYER] = 200
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    for (const id of crew) loadWorker(world, id, CARRY_GOLD, 10)
    const staged = totalOf(world, TEAM_PLAYER, CARRY_GOLD)
    world.militiaCooldown[TEAM_PLAYER] = 0 // staging: skip the 120 s cooldown
    world.ringMilitiaBell(TEAM_PLAYER)
    assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), staged, 1e-4, `cycle ${cycle}: ring conserves`)
    const banked = stepUntil(world, () => world.gold[TEAM_PLAYER] === 200 + 30 * cycle, 3600)
    assert(banked, `cycle ${cycle}: all three loads banked on arming`)
    assertEqual(pilesOf(world, TEAM_PLAYER).length, 0, `cycle ${cycle}: no pile created`)
    const released = stepUntil(world, () => crew.every((id) => !world.isBellDuty(id)), 3600)
    assert(released, `cycle ${cycle}: the crew completes the return before the next ring`)
    assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), staged, 1e-4, `cycle ${cycle}: cycle conserves`)
  }
})

// ---- ownership (property 3) -------------------------------------------------

test('ownership: an enemy worker standing on a pile can never take it', () => {
  const world = makeBareWorld()
  const pile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 3, 3).id
  const enemy = world.spawnUnit('worker', TEAM_ENEMY, 3, 3).id
  stepWorld(world, 120)
  assertEqual(world.carryAmount[pile], 10, 'pile untouched by the enemy')
  assertEqual(world.carryAmount[enemy], 0, 'enemy carries nothing')
  assert(world.entities.has(pile), 'pile persists')
})

// ---- kind discipline (property 5) --------------------------------------------

test('kind discipline: a wood carrier ignores a gold pile; stacked kinds resolve in pile-id order', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  // Staged far from the hall (30,30) so a loaded worker walks home for
  // many ticks instead of depositing mid-test. Wood pile spawned
  // first: it holds the lower pile id at this point.
  const woodPile = world.spawnPile(TEAM_PLAYER, CARRY_WOOD, 7, 30, 30).id
  const goldPile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 30, 30).id

  const woodHand = world.spawnUnit('worker', TEAM_PLAYER, 30, 30).id
  loadWorker(world, woodHand, CARRY_WOOD, 4)
  world.update(STEP)
  assertEqual(world.carryAmount[woodHand], 10, 'wood carrier topped up from the WOOD pile only')
  assertEqual(world.carryKind[woodHand], CARRY_WOOD, 'still carrying wood — kinds never mix')
  assertEqual(world.carryAmount[goldPile], 10, 'gold pile untouched by the wood carrier')
  assertEqual(world.carryAmount[woodPile], 1, 'wood pile left the exact remainder (7 − 6)')

  // An empty worker on the same point takes the lower pile id first.
  const empty = world.spawnUnit('worker', TEAM_PLAYER, 30, 30).id
  world.update(STEP)
  assertEqual(world.carryKind[empty], CARRY_WOOD, 'empty worker took the remaining wood pile first (lower id)')
  assertEqual(world.carryAmount[empty], 1, 'took the 1 wood')
  world.update(STEP)
  assertEqual(world.carryAmount[empty], 1, 'a loaded worker never switches kinds mid-load')
  assertEqual(world.carryAmount[goldPile], 10, 'gold pile still waits for empty hands')
})

test('oversized pile: a standard worker takes carryMax and leaves the rest', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  // A 20-load pile (a merged pair, or a Drudge-sized load) vs carryMax 10.
  const pile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 20, 3, 3).id
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 3, 3).id
  world.update(STEP)
  assertEqual(world.carryAmount[worker], 10, 'worker filled to its own carryMax')
  assertEqual(world.carryAmount[pile], 10, 'the other 10 stays piled')
})

// ---- save/load (property 7) ---------------------------------------------------

test('save/load: piles round-trip exactly at SAVE_VERSION 1 and keep working after load', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  world.spawnUnit('worker', TEAM_PLAYER, 5, 5) // stands on the pile: its recoverer
  world.gold[TEAM_PLAYER] = 200
  const pile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 5, 5).id

  const save = serializeWorld(world, 0, [])
  assertEqual(save.version, 1, 'the slice does not move SAVE_VERSION')
  const restored = makeBareWorld()
  deserializeWorld(restored, save)

  const restoredPiles = pilesOf(restored, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(restoredPiles.length, 1, 'one pile survives the round-trip')
  const rp = restoredPiles[0]
  assertEqual(rp, pile, 'pile id preserved')
  assertEqual(restored.carryAmount[rp], 10, 'pile amount exact after load')
  assertEqual(restored.team[rp], TEAM_PLAYER, 'pile team exact after load')
  assertEqual(restored.positionX[rp], 5, 'pile x exact after load')
  assertEqual(restored.positionZ[rp], 5, 'pile z exact after load')
  // The restored world keeps playing the mechanic: pickup → deposit.
  const deposited = stepUntil(restored, () => restored.gold[TEAM_PLAYER] === 210, 3600)
  assert(deposited, 'recovered load deposits in the loaded world')
  assertEqual(pilesOf(restored, TEAM_PLAYER).length, 0, 'no pile remains after load-cycle')
})

// ---- determinism (property 8, note §6 scripted scenario) ----------------------

test('determinism: the scripted ring → travel → en-route kill → pile scenario hashes identically across runs', () => {
  const runScenario = () => {
    const world = makeBareWorld()
    world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
    const doomed = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
    const survivor = world.spawnUnit('worker', TEAM_PLAYER, 10, 5).id
    world.gold[TEAM_PLAYER] = 200
    world.health[doomed] = 5 // staging: the scripted blow kills in one swing
    loadWorker(world, doomed, CARRY_GOLD, 10)
    loadWorker(world, survivor, CARRY_GOLD, 10)
    world.ringMilitiaBell(TEAM_PLAYER)
    const hashes: string[] = []
    let sawMuster = false
    let sawPile = false
    let killer = -1
    for (let tick = 0; tick < 3600; tick += 1) {
      if (tick === 30) {
        killer = world.spawnUnit('melee', TEAM_ENEMY, world.positionX[doomed] - 1.5, 0.3).id
        world.state[killer] = STATE_ATTACK
        world.targetId[killer] = doomed
        world.cooldown[killer] = 0
      }
      if (tick === 34 && killer >= 0 && world.entities.has(killer)) {
        // Staging cleanup, identical in both runs: the killer's part is
        // done; the scenario measures the bell machine, not a siege.
        world.removeEntityById(killer)
      }
      world.update(STEP)
      if (world.state[survivor] === STATE_MUSTER) sawMuster = true
      if (pilesOf(world, TEAM_PLAYER).length > 0) sawPile = true
      if ((tick + 1) % 60 === 0) hashes.push(hashToHex(hashWorldState(world)))
    }
    return {
      hashes,
      sawMuster,
      sawPile,
      bank: world.gold[TEAM_PLAYER],
      pilesLeft: pilesOf(world, TEAM_PLAYER).length,
      doomedGone: workerGone(world, doomed),
    }
  }
  const a = runScenario()
  // The scenario must EXERCISE the mechanic, or the parity proves nothing.
  assert(a.sawMuster, 'scenario window contains the trip')
  assert(a.sawPile, 'scenario window contains the en-route death pile')
  assert(a.doomedGone, 'the scripted kill landed')
  assertEqual(a.bank, 210, 'the survivor’s load banked on arming')
  assertEqual(a.pilesLeft, 1, 'the death pile persists — nobody recovered it in this scenario')
  const b = runScenario()
  assertEqual(a.hashes.length, b.hashes.length, 'same number of hash checkpoints')
  for (let i = 0; i < a.hashes.length; i += 1) {
    assertEqual(a.hashes[i], b.hashes[i], `hash mismatch at checkpoint ${i} (tick ${(i + 1) * 60})`)
  }
})

// ---- boundedness (property 6) ---------------------------------------------------

test('cap: at 32 piles of a kind, a death-drop merges into the nearest own pile at any distance', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const staged: number[] = []
  for (let i = 0; i < PILE_MAX_PER_TEAM_KIND; i += 1) {
    staged.push(world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 100 + i * 3, 100).id)
  }
  const entitiesBefore = world.entities.size

  // The death-drop entry point itself (combat's deferred spawn calls
  // exactly this): at the cap it must merge, never spawn a 33rd pile.
  world.dropLoadAsPile(TEAM_PLAYER, CARRY_GOLD, 5, 5, 5)

  const piles = pilesOf(world, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(piles.length, PILE_MAX_PER_TEAM_KIND, 'pile count stays at the cap — no 33rd pile')
  assertEqual(world.entities.size, entitiesBefore, 'the drop created no entity')
  assertEqual(world.carryAmount[staged[0]], 15, 'the nearest pile (100,100) absorbed the drop')
  let piledTotal = 0
  for (const p of piles) piledTotal += world.carryAmount[p]
  assertEqual(piledTotal, 325, 'all value still piled: 32×10 + 5')
})

test('capacity backstop: a death-drop at full entity capacity lands in the corpse’s own freed slot', () => {
  const world = new World({ capacity: 41 })
  world.factionOfTeam = ['human' as never, 'human' as never]
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 15, 0).id
  const killer = world.spawnUnit('melee', TEAM_ENEMY, 70, 70).id
  while (world.entities.size < 41) world.spawnResource('wood', 60, 60)
  loadWorker(world, worker, CARRY_GOLD, 10)
  world.gold[TEAM_PLAYER] = 200
  const before = totalOf(world, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(world.entities.size, 41, 'staging check: the world is exactly full')

  const called = world.ringMilitiaBell(TEAM_PLAYER) // must not throw at capacity
  assertEqual(called, 1, 'the peasant is still called at full capacity')
  assertEqual(world.carryAmount[worker], 10, 'the ring drops nothing — the load rides with him')
  stepWorld(world, 10)
  assertEqual(world.state[worker], STATE_MUSTER, 'mid-trip at the kill')

  // The kill, staged by teleporting the pre-spawned killer in (a fresh
  // spawn would itself exceed capacity — that is the point of the test).
  world.health[worker] = 1
  world.positionX[killer] = world.positionX[worker] + 0.5
  world.positionZ[killer] = world.positionZ[worker]
  world.state[killer] = STATE_ATTACK
  world.targetId[killer] = worker
  world.cooldown[killer] = 0
  const died = stepUntil(world, () => workerGone(world, worker), 120)
  assert(died, 'the traveler dies at full capacity')

  // The deferred spawn runs AFTER the removal loop: the corpse's own
  // freed slot receives the pile, so the load survives even here. (The
  // pile note's capacity exception — skip the spawn when no slot can
  // be freed — cannot trigger from a death: the death frees the slot.)
  const piles = pilesOf(world, TEAM_PLAYER, CARRY_GOLD)
  assertEqual(piles.length, 1, 'the pile spawned into the freed slot')
  assertEqual(world.carryAmount[piles[0]], 10, 'the pile holds the exact load')
  assert(world.entities.size <= 41, 'capacity never exceeded')
  assertClose(totalOf(world, TEAM_PLAYER, CARRY_GOLD), before, 1e-4, 'total conserved at full capacity')
})

// ---- isolation (property 9) -------------------------------------------------------

test('isolation: combat cannot damage a pile, gather cannot harvest one, supply ignores it', () => {
  const world = makeBareWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  const pile = world.spawnPile(TEAM_PLAYER, CARRY_GOLD, 10, 8, 8).id

  // Combat: an enemy melee with a staged attack order on the pile.
  const melee = world.spawnUnit('melee', TEAM_ENEMY, 8, 9).id
  world.state[melee] = STATE_ATTACK
  world.targetId[melee] = pile
  world.moving[melee] = 0
  stepWorld(world, 120)
  assert(world.entities.has(pile), 'pile survives staged attack orders')
  assertEqual(world.health[pile], 1, 'pile took no damage')
  assertEqual(world.carryAmount[pile], 10, 'pile amount untouched by combat')

  // Gather: a worker staged mid-"gather" on the pile (10 away, so the
  // contact pickup cannot fire) treats it as a spent node, not a source.
  const worker = world.spawnUnit('worker', TEAM_PLAYER, 18, 8).id
  world.state[worker] = STATE_GATHER
  world.targetId[worker] = pile
  world.update(STEP)
  assertEqual(world.carryAmount[worker], 0, 'worker extracted nothing from the pile')
  assertEqual(world.carryKind[worker], CARRY_NONE, 'worker kind unchanged')
  assertEqual(world.carryAmount[pile], 10, 'pile not depleted by gather')
  assertEqual(world.wildHeat[TEAM_PLAYER], 0, 'no Living Wild heat from a pile')

  // Supply: piles are not units and not buildings.
  const supplyBefore = world.supplyUsed[TEAM_PLAYER]
  world.spawnPile(TEAM_PLAYER, CARRY_WOOD, 5, 20, 20)
  assertEqual(world.supplyUsed[TEAM_PLAYER], supplyBefore, 'supply ignores piles')
  assertEqual(world.state[worker], STATE_IDLE, 'the gather-staged worker fell back to idle')
})
