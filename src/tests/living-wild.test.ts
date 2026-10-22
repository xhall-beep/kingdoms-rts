/**
 * Living Wild tests (v2.0 canon): over-harvest spawns hostile treants.
 *
 * Wild heat accrues from wood torn out of trees (never from gold, never
 * from elven sap-taps) and decays at 4/s. Measured on the seeded
 * scenario: a 4-worker economy pulls ~1.3 wood/s from trees, a grown
 * 9-worker economy peaks near 8.5 wood/s in its opening minutes, and a
 * deliberate clear-cut sustains 8–15 wood/s. The 600 threshold sits
 * above anything an honest economy accumulates and trips a clear-cut
 * in about a minute and a half.
 */
import {
  World,
  KIND_TREANT,
  STATE_ATTACK,
  TEAM_PLAYER,
  TEAM_ENEMY,
  NO_TARGET,
} from '../core/World.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import {
  LivingWildSystemImpl,
  WILD_HEAT_THRESHOLD,
} from '../systems/living-wild.ts'
import { hashWorldState } from '../net/hash.ts'
import { STEP, stepWorld } from './setup.ts'
import { suite, test, assert, assertEqual } from './harness.ts'

suite('living wild: the forest answers clear-cutting')

function makeWildWorld(withWild = true): World {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  if (withWild) world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

/** A hall, a wood line of `workers` workers, and a 6x4 tree cluster. */
function seedWoodLine(world: World, team: 0 | 1, workers: number): void {
  world.spawnBuilding('hall', team, 0, 0, true)
  for (let i = 0; i < workers; i += 1) {
    world.spawnUnit('worker', team, 3 + (i % 4) * 2, -3 + Math.floor(i / 4) * 2)
  }
  for (let gx = 0; gx < 6; gx += 1) {
    for (let gz = 0; gz < 4; gz += 1) {
      world.spawnResource('wood', 10 + gx * 3, -4.5 + gz * 3)
    }
  }
}

function treantIds(world: World): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_TREANT) out.push(id)
  }
  return out
}

test('ordinary harvesting builds heat but never wakes the forest', () => {
  const world = makeWildWorld()
  seedWoodLine(world, TEAM_PLAYER, 3)
  let peakHeat = 0
  for (let s = 0; s < 3600; s += 60) {
    stepWorld(world, 60)
    peakHeat = Math.max(peakHeat, world.wildHeat[TEAM_PLAYER])
  }
  assert(world.wood[TEAM_PLAYER] > 0, 'sanity: the wood line actually harvested')
  assert(peakHeat > 0, 'sanity: harvesting fed the wild heat')
  assert(
    peakHeat < WILD_HEAT_THRESHOLD,
    `peak heat ${peakHeat.toFixed(1)} stayed below the ${WILD_HEAT_THRESHOLD} threshold`,
  )
  assertEqual(treantIds(world).length, 0, 'no treant rose for an honest wood line')
})

/** Run a 14-worker clear-cut until the first treant rises; report the step. */
function runClearCut(): { world: World; spawnStep: number } {
  const world = makeWildWorld()
  seedWoodLine(world, TEAM_PLAYER, 14)
  let spawnStep = -1
  for (let s = 0; s < 12000; s += 1) {
    world.update(STEP)
    if (treantIds(world).length > 0) {
      spawnStep = s
      break
    }
  }
  return { world, spawnStep }
}

test('sustained clear-cutting raises a treant at the harvest site', () => {
  const { world, spawnStep } = runClearCut()
  assert(spawnStep > 0, 'a treant rose under sustained clear-cutting')
  const [treant] = treantIds(world)
  // Spawn point: the tree being cut (within a step's walk of a tree).
  let nearestTree = Infinity
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== 7) continue // KIND_TREE
    const d = Math.hypot(
      world.positionX[id] - world.positionX[treant],
      world.positionZ[id] - world.positionZ[treant],
    )
    nearestTree = Math.min(nearestTree, d)
  }
  assert(nearestTree <= 2, `treant rose at the harvest site (nearest tree ${nearestTree.toFixed(2)})`)
  // The trigger consumed the threshold: heat restarts below it.
  assert(
    world.wildHeat[TEAM_PLAYER] < WILD_HEAT_THRESHOLD,
    'heat dropped back below the threshold after the spawn',
  )
})

test('the spawn is deterministic: same scenario, same tick, same hash', () => {
  const a = runClearCut()
  const b = runClearCut()
  assert(a.spawnStep > 0 && b.spawnStep > 0, 'sanity: both runs raised a treant')
  assertEqual(b.spawnStep, a.spawnStep, 'treant rose on the identical tick')
  stepWorld(a.world, 600)
  stepWorld(b.world, 600)
  assertEqual(
    hashWorldState(a.world),
    hashWorldState(b.world),
    'identical runs hash identically across the spawn',
  )
})

test('the treant hunts the worker who was cutting', () => {
  const world = makeWildWorld()
  // Two team-0 workers: the offender at the tree line, a bystander far away,
  // plus a team-1 worker standing even closer to the rise point.
  const hall = world.spawnBuilding('hall', TEAM_PLAYER, -30, -30, true)
  void hall
  const offender = world.spawnUnit('worker', TEAM_PLAYER, 6, 5)
  world.spawnUnit('worker', TEAM_PLAYER, -28, -28)
  world.spawnUnit('worker', TEAM_ENEMY, 7, 5)
  world.wildHeat[TEAM_PLAYER] = WILD_HEAT_THRESHOLD + 10
  world.wildSiteX[TEAM_PLAYER] = 5
  world.wildSiteZ[TEAM_PLAYER] = 5
  world.wildWorker[TEAM_PLAYER] = offender.id
  stepWorld(world, 1)
  const treants = treantIds(world)
  assertEqual(treants.length, 1, 'exactly one treant rose')
  const treant = treants[0]
  assertEqual(world.targetId[treant], offender.id, 'treant targets the recorded over-harvester')
  assertEqual(world.state[treant], STATE_ATTACK, 'treant is on the attack')
  // And it connects: the offender bleeds within half a minute.
  stepWorld(world, 1800)
  const hurt =
    !world.entities.has(offender.id) ||
    world.health[offender.id] < world.maxHealth[offender.id]
  assert(hurt, 'the offender took damage from the treant')
})

test('wild state is part of the hashed sim state', () => {
  const a = new World()
  const b = new World()
  assertEqual(hashWorldState(a), hashWorldState(b), 'identical worlds hash identically')
  b.wildHeat[0] = 25
  assert(hashWorldState(a) !== hashWorldState(b), 'wild heat changes the hash')
})

test('elven sap-tapping feeds no heat', () => {
  const world = makeWildWorld()
  world.factionOfTeam = ['elf', 'human']
  seedWoodLine(world, TEAM_PLAYER, 3)
  stepWorld(world, 1800)
  assert(world.wood[TEAM_PLAYER] > 0, 'sanity: elves harvested and deposited wood')
  assertEqual(world.wildHeat[TEAM_PLAYER], 0, 'sap-tapping never angers the forest')
  assertEqual(treantIds(world).length, 0, 'no treant for the elves')
})

test('a treant loose among elves crashes nothing and fights', () => {
  const world = new World()
  world.factionOfTeam = ['elf', 'human']
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  const elf = world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  const treant = world.spawnTreant(6, 0)
  stepWorld(world, 600) // 10 s of mutual combat, vision and movement live
  const someoneBled =
    world.health[elf.id] < world.maxHealth[elf.id] ||
    !world.entities.has(treant.id) ||
    world.health[treant.id] < world.maxHealth[treant.id]
  assert(someoneBled, 'treant and elf actually fought')
  assertEqual(typeof hashWorldState(world), 'bigint', 'world still hashes after the fight')
})

test('wild state survives save/load; old saves restore calm', async () => {
  const { serializeWorld, deserializeWorld } = await import('../session/save-load.ts')
  const world = makeWildWorld()
  seedWoodLine(world, TEAM_PLAYER, 2)
  world.wildHeat[TEAM_PLAYER] = 321.5
  world.wildSiteX[TEAM_PLAYER] = 13
  world.wildSiteZ[TEAM_PLAYER] = -4.5
  world.wildWorker[TEAM_PLAYER] = 7
  const save = serializeWorld(world, 0, [])
  const restored = makeWildWorld()
  deserializeWorld(restored, save)
  assertEqual(restored.wildHeat[TEAM_PLAYER], 321.5, 'heat restored')
  assertEqual(restored.wildSiteX[TEAM_PLAYER], 13, 'site X restored')
  assertEqual(restored.wildSiteZ[TEAM_PLAYER], -4.5, 'site Z restored')
  assertEqual(restored.wildWorker[TEAM_PLAYER], 7, 'offender restored')
  // A save that predates the Living Wild loads with a calm forest.
  const legacy = serializeWorld(world, 0, []) as unknown as Record<string, unknown>
  delete legacy.wildHeat
  delete legacy.wildSiteX
  delete legacy.wildSiteZ
  delete legacy.wildWorker
  const restoredLegacy = makeWildWorld()
  deserializeWorld(restoredLegacy, legacy as never)
  assertEqual(restoredLegacy.wildHeat[TEAM_PLAYER], 0, 'legacy save: no heat')
  assertEqual(restoredLegacy.wildWorker[TEAM_PLAYER], NO_TARGET, 'legacy save: no offender')
})
