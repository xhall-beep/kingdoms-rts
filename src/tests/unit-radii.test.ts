/**
 * Unit radii (mechanics audit item 10, 2026-11-06): all trainable units
 * shared radius 0.5, so a footman read the same size as a peasant —
 * flattening combat reach (range + target radius), separation contact,
 * tap targets, and sprite size — and the slice-7 "combat units
 * (radius 0.9, 25.7px box)" claim was false at the time it was
 * written. Now worker 0.5, melee 0.65, ranged 0.7, carried on the unit
 * defs (STANDARD_UNITS spreads them, so Standard Battle stays in
 * sync by construction). Melee was 0.9 in the original slice
 * (2026-11-10, QA PASS) whose proving run HALTED on balance cost
 * (undead −3, timeouts 12/36, flips 11); the first retune step,
 * 0.75, still breached the flip bound (7 vs ≤4; timeouts 6 and
 * undead −2 at their bounds); the second, 0.7, also breached
 * (6 vs ≤4; timeouts 5, undead −2). This file pins the third retune
 * step, melee 0.65 (2026-11-16).
 *
 * The radius is sim state (hashed): the twin hash moves with this
 * slice and is re-baselined, not pinned here. Balance effect is
 * measured by the canonical-36 farm in proving, not by this file.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY } from '../core/World.ts'
import { UNITS } from '../data/units.ts'
import { STANDARD_UNITS } from '../data/standard.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl, orderAttack } from '../systems/combat.ts'
import { unitSpriteSize } from '../render/renderer.ts'
import { suite, test, assert, assertClose } from './harness.ts'
import { STEP } from './setup.ts'

suite('unit-radii')

function bareWorld(): World {
  const world = new World()
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

test('spawned radii are worker 0.5, melee 0.65, ranged 0.7', () => {
  const world = bareWorld()
  const w = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  const m = world.spawnUnit('melee', TEAM_PLAYER, 5, 0)
  const r = world.spawnUnit('ranged', TEAM_PLAYER, 10, 0)
  // Float32Array storage: the tolerance must exceed float32 rounding
  // (1e-6), not 1e-9.
  assertClose(world.radius[w.id], 0.5, 1e-6, 'worker radius')
  assertClose(world.radius[m.id], 0.65, 1e-6, 'melee radius')
  assertClose(world.radius[r.id], 0.7, 1e-6, 'ranged radius')
})

test('unit defs carry the radii (standard copy in sync)', () => {
  // Float32Array storage (see the spawn test above): 1e-6, not 1e-9.
  assertClose(UNITS.worker.radius, 0.5, 1e-6, 'worker def')
  assertClose(UNITS.melee.radius, 0.65, 1e-6, 'melee def')
  assertClose(UNITS.ranged.radius, 0.7, 1e-6, 'ranged def')
  assertClose(STANDARD_UNITS.worker.radius, 0.5, 1e-6, 'standard worker')
  assertClose(STANDARD_UNITS.melee.radius, 0.65, 1e-6, 'standard melee')
  assertClose(STANDARD_UNITS.ranged.radius, 0.7, 1e-6, 'standard ranged')
})

test('melee reach extends with target radius: strikes a melee at 2.7 in place', () => {
  const world = bareWorld()
  const atk = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const tgt = world.spawnUnit('melee', TEAM_ENEMY, 2.7, 0)
  orderAttack(world, atk.id, tgt.id)
  world.update(STEP)
  // Reach vs a melee target is 2.1 + 0.65 = 2.75, so 2.7 is already in
  // range. (Staged at 2.7, not exactly 2.75: float32 storage leaves
  // the reach an ulp short of 2.75 — the same boundary the 0.9 QA
  // noted at 3.0.) The first strike lands on tick 1 and the
  // attacker never moves.
  assert(world.health[tgt.id] < 170, `melee target struck in place, hp=${world.health[tgt.id]}`)
  assertClose(world.positionX[atk.id], 0, 1e-9, 'attacker did not move')
})

test('melee reach stops short of a worker at 2.8: must close first', () => {
  const world = bareWorld()
  const atk = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const tgt = world.spawnUnit('worker', TEAM_ENEMY, 2.8, 0)
  orderAttack(world, atk.id, tgt.id)
  world.update(STEP)
  // Reach vs a worker is 2.1 + 0.5 = 2.6, so 2.8 is out of range: no
  // strike on tick 1, and the attacker is already closing the gap.
  assert(world.health[tgt.id] === 60, `worker not yet struck, hp=${world.health[tgt.id]}`)
  assert(world.positionX[atk.id] > 0, 'attacker closed toward the worker')
})

test('world radii drive the sprite boxes at boot zoom 13', () => {
  // Boot zoom is 13; draw radius r = max(5, worldRadius * zoom).
  // Ranged 20.02px sits above the 19px floor; the worker stays
  // floored at 19px. Melee at 0.65 draws 18.59px before the floor,
  // so it lands on the 19px floor with the worker — the visual-size
  // distinction the 0.7 step bought is gone at 0.65 (reach and
  // separation still differ). This pins the floor, not a size.
  const world = bareWorld()
  const m = world.spawnUnit('melee', TEAM_PLAYER, 0, 0)
  const r = world.spawnUnit('ranged', TEAM_PLAYER, 5, 0)
  const w = world.spawnUnit('worker', TEAM_PLAYER, 10, 0)
  assertClose(unitSpriteSize(world.radius[m.id] * 13), 19, 0.01, 'melee sprite floor')
  assertClose(unitSpriteSize(world.radius[r.id] * 13), 20.02, 0.01, 'ranged sprite')
  assertClose(unitSpriteSize(world.radius[w.id] * 13), 19, 0.01, 'worker sprite floor')
})

test('two coincident melee separate to their contact distance', () => {
  const world = bareWorld()
  const a = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  const b = world.spawnUnit('melee', TEAM_PLAYER, 10, 10)
  for (let t = 0; t < 645; t++) world.update(STEP)
  const d = Math.hypot(
    world.positionX[a.id] - world.positionX[b.id],
    world.positionZ[a.id] - world.positionZ[b.id],
  )
  // Contact distance is 0.65 + 0.65 = 1.3; 1.2 allows settle tolerance.
  assert(d >= 1.2, `melee pair separated to ${d.toFixed(3)}, expected >= 1.2 (contact 1.3)`)
})
