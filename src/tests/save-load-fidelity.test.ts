/**
 * Save/load fidelity regression tests — B4 (Chaos fuzz, 2026-10-26).
 *
 * The filed defect: a save → load round-trip did NOT reproduce the saved
 * world. `world.tick` was never stored or restored (the hash has covered
 * tick since the registry unification), the id-allocation state was
 * reconstructed from the entity set instead of carried verbatim (a
 * removed entity's id — e.g. a treant killed at the top of the id space —
 * changed the next post-load spawn's id), the victory/shrine check
 * timers were dropped, entity arrays were copied only through a
 * [0..maxId] window (stale slots above it survived from the target
 * world), and the shipped JSON persistence turned resumeX/resumeZ NaNs
 * into 0. Continuations then diverged for real: fuzz matches flipped
 * winners after a reload.
 *
 * The standard these tests pin: hash-identity across the round-trip
 * (direct AND through JSON, the way writeSave/readSave persist) and
 * identical continuation behavior — not field survival.
 */
import { KIND_BARRACKS } from '../core/World.ts'
import type { World } from '../core/World.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'
import type { WorldSave } from '../session/save-load.ts'
import { hashWorldState } from '../net/hash.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { enqueueTrain, researchUpgrade, trainingQueueFor } from '../systems/production.ts'
import { orderAttack } from '../systems/combat.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

function throughJson(save: WorldSave): WorldSave {
  return JSON.parse(JSON.stringify(save)) as WorldSave
}

function restoreInto(save: WorldSave, withAi: boolean): World {
  const w = makeWorld()
  if (withAi) w.registerSystem(new OpponentAI(1, 'normal', 'expander'))
  deserializeWorld(w, save)
  return w
}

function victoryTimer(w: World): number {
  const s = w.systems.find((x) => x instanceof VictorySystemImpl) as VictorySystemImpl
  return s.getTimer()
}
function shrineTimer(w: World): number {
  const s = w.systems.find((x) => x instanceof ShrineSystemImpl) as ShrineSystemImpl
  return s.getTimer()
}
function setTimers(w: World, victory: number, shrine: number): void {
  ;(w.systems.find((x) => x instanceof VictorySystemImpl) as VictorySystemImpl).setTimer(victory)
  ;(w.systems.find((x) => x instanceof ShrineSystemImpl) as ShrineSystemImpl).setTimer(shrine)
}

suite('save/load fidelity (B4)')

test('round-trip hash identity: virgin world, direct and via JSON', () => {
  const a = makeWorld()
  const direct = restoreInto(serializeWorld(a, 0, []), false)
  assertEqual(hashWorldState(direct), hashWorldState(a), 'virgin world survives a direct round-trip')
  const viaJson = restoreInto(throughJson(serializeWorld(a, 0, [])), false)
  assertEqual(hashWorldState(viaJson), hashWorldState(a), 'virgin world survives the JSON persistence path (NaN resume targets)')
})

test('round-trip hash identity: stepped idle worlds (600 / 3600 ticks)', () => {
  for (const ticks of [600, 3600]) {
    const a = makeWorld()
    stepWorld(a, ticks)
    const b = restoreInto(throughJson(serializeWorld(a, ticks, [])), false)
    assertEqual(b.tick, a.tick, `tick restored at ${ticks}`)
    assertEqual(hashWorldState(b), hashWorldState(a), `hash identical after round-trip at ${ticks} ticks`)
  }
})

test('round-trip hash identity: AI match at 3600 and 10800 ticks', () => {
  for (const ticks of [3600, 10800]) {
    const a = makeWorld()
    a.registerSystem(new OpponentAI(1, 'normal', 'expander'))
    stepWorld(a, ticks)
    const direct = restoreInto(serializeWorld(a, ticks, []), true)
    assertEqual(hashWorldState(direct), hashWorldState(a), `direct round-trip hash at ${ticks}`)
    const viaJson = restoreInto(throughJson(serializeWorld(a, ticks, [])), true)
    assertEqual(hashWorldState(viaJson), hashWorldState(a), `JSON round-trip hash at ${ticks}`)
    assertEqual(viaJson.getNextEntityId(), a.getNextEntityId(), `nextEntityId carried at ${ticks}`)
    assertEqual(
      JSON.stringify(viaJson.getFreeIds()),
      JSON.stringify(a.getFreeIds()),
      `free-id stack carried verbatim (contents + order) at ${ticks}`,
    )
  }
})

test('round-trip hash identity: staged mid-match (tech, queue, research, timers)', () => {
  const a = makeWorld()
  a.gold[0] = 100000
  a.wood[0] = 100000
  a.spawnBuilding('workshop', 0, 20, 0, true)
  const smithy = a.spawnBuilding('smithy', 0, 26, 0, true)
  a.spawnBuilding('archery', 0, -26, 0, true)
  let barracksId = -1
  for (const id of a.entities.keys()) {
    if (a.kind[id] === KIND_BARRACKS && a.team[id] === 0) barracksId = id
  }
  if (barracksId < 0) barracksId = a.spawnBuilding('barracks', 0, 0, 26, true).id
  assert(researchUpgrade(a, smithy.id, 'meleeDmg'), 'staged research lands at the smithy')
  assert(enqueueTrain(a, barracksId, 'melee'), 'staged melee enqueue lands')
  assert(enqueueTrain(a, barracksId, 'ranged'), 'staged archer enqueue lands (range stands)')
  stepWorld(a, 90)
  setTimers(a, 0.25, 0.375)
  const b = restoreInto(throughJson(serializeWorld(a, a.tick, [])), false)
  assertEqual(hashWorldState(b), hashWorldState(a), 'staged mid-match state is hash-identical after load')
  assertEqual(victoryTimer(b), 0.25, 'victory check timer carried by the save')
  assertEqual(shrineTimer(b), 0.375, 'shrine check timer carried by the save')
  assertEqual(
    JSON.stringify(trainingQueueFor(b, barracksId)),
    JSON.stringify(trainingQueueFor(a, barracksId)),
    'training queue identical after load',
  )
})

test('continuation identity: a reloaded world stays on the no-save timeline', () => {
  const a = makeWorld()
  stepWorld(a, 1800)
  const save = throughJson(serializeWorld(a, a.tick, []))
  const spawnedA = a.spawnUnit('melee', 0, 5, 5)
  const b = restoreInto(save, false)
  const spawnedB = b.spawnUnit('melee', 0, 5, 5)
  assertEqual(spawnedB.id, spawnedA.id, 'first post-load spawn takes the same id as the no-save timeline')
  for (let chunk = 1; chunk <= 4; chunk += 1) {
    stepWorld(a, 300)
    stepWorld(b, 300)
    assertEqual(hashWorldState(b), hashWorldState(a), `continuation identical at +${chunk * 300} ticks after load`)
  }
  assertEqual(b.winner, a.winner, 'same winner (or none) after continuation')
})

test('removed-entity id state: post-load spawns reuse ids in the no-save order', () => {
  // The 10800-tick AI history is the filed repro's history: entities were
  // created and removed, leaving nextEntityId=95 and freeIds=[51, 94].
  const a = makeWorld()
  a.registerSystem(new OpponentAI(1, 'normal', 'expander'))
  stepWorld(a, 10800)
  const b = restoreInto(throughJson(serializeWorld(a, a.tick, [])), false)
  assertEqual(b.getNextEntityId(), a.getNextEntityId(), 'id counter survives the removal history')
  assertEqual(JSON.stringify(b.getFreeIds()), JSON.stringify(a.getFreeIds()), 'free-id stack survives verbatim')
  // Detach the AI from the live world too, so the continuation compares
  // sim timelines, not AI memories (AI internal state is not world state).
  a.systems.splice(0, a.systems.length, ...a.systems.filter((s) => !(s instanceof OpponentAI)))
  const firstA = a.spawnUnit('worker', 0, -5, -5)
  const firstB = b.spawnUnit('worker', 0, -5, -5)
  assertEqual(firstB.id, firstA.id, 'first spawn after load recycles the same id')
  const secondA = a.spawnUnit('worker', 0, -6, -6)
  const secondB = b.spawnUnit('worker', 0, -6, -6)
  assertEqual(secondB.id, secondA.id, 'second spawn after load also matches')
  stepWorld(a, 120)
  stepWorld(b, 120)
  assertEqual(hashWorldState(b), hashWorldState(a), 'post-load timelines stay identical')
})

test('entity at <=0 HP pending removal is captured with its state', () => {
  const a = makeWorld()
  // Stage the intra-tick state combat leaves between dealing lethal
  // damage and its removal pass: the entity is in the set at <=0 HP.
  // (A between-frames save never actually observes this — combat's
  // removal pass runs inside the same update that deals the damage,
  // and the fuzz treant turned out to be already-removed, its legacy
  // being the id state covered above. The rule pinned here is the
  // conservative one: whatever is in the set at capture is captured
  // whole, so even this state round-trips onto the same timeline.)
  const victim = a.spawnUnit('melee', 0, 10, 10).id
  const attacker = a.spawnUnit('melee', 1, 11, 10).id
  a.health[victim] = -5
  const b = restoreInto(throughJson(serializeWorld(a, 0, [])), false)
  assert(b.entities.has(victim), 'dying entity is captured by the save, not dropped')
  assertEqual(b.health[victim], -5, 'dying entity health round-trips')
  // Continuation stays identical. (Targeting deliberately skips <=0 HP
  // entities, so the victim is not re-collected by combat on either
  // timeline — identically inert on both.)
  for (const w of [a, b]) orderAttack(w, attacker, victim)
  for (let chunk = 1; chunk <= 4; chunk += 1) {
    stepWorld(a, 30)
    stepWorld(b, 30)
    assertEqual(hashWorldState(b), hashWorldState(a), `dying-entity timelines identical at +${chunk * 30} ticks`)
  }
  // When removal does resolve (identically, by hand here), the freed id
  // returns to the same stack position on both timelines.
  a.removeEntityById(victim)
  b.removeEntityById(victim)
  const recycledA = a.spawnUnit('worker', 0, -5, -5)
  const recycledB = b.spawnUnit('worker', 0, -5, -5)
  assertEqual(recycledB.id, recycledA.id, 'post-removal spawn recycles the same id on both timelines')
  assertEqual(recycledB.id, victim, 'the recycled id is the victim\'s')
})

test('legacy save (pre-B4 fields absent) still loads with the step fallback', () => {
  const a = makeWorld()
  stepWorld(a, 120)
  const legacy = throughJson(serializeWorld(a, 120, [])) as unknown as Record<string, unknown>
  delete legacy.tick
  delete legacy.nextEntityId
  delete legacy.freeIds
  delete legacy.victoryTimer
  delete legacy.shrineTimer
  const b = makeWorld()
  deserializeWorld(b, legacy as unknown as WorldSave)
  assertEqual(b.tick, 120, 'legacy save restores tick from the stored step count')
  stepWorld(b, 60)
  assert(b.tick === 180, 'legacy-loaded world keeps stepping')
})
