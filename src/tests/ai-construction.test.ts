/**
 * AI construction-supervision regression — guards the 2026-10-16 stalled-build fix.
 *
 * Found by the post-fix balance series: orc and elf expanders built a barracks
 * (~1.2 min) whose construction stalled at 5-7/10 progress and never resumed —
 * the builder had been yanked off the site by raid evacuation, and nothing
 * ever re-assigned one. The half-built husk still counted toward the build
 * plan, so the AI never retried: 150g/110w sunk, zero melee trained in
 * 8 minutes (human/undead were unaffected — 54-65% melee share).
 *
 * Fix: (1) raid evacuation no longer pulls workers off construction sites,
 * (2) a per-think supervisor re-arms one idle worker per stalled site
 * (direct orderBuild, or a 'build'-command resume via siteId in lockstep).
 */
import { World, KIND_BARRACKS, KIND_HALL, KIND_WORKER, KIND_MELEE, KIND_RANGED, KIND_ARCHERY, STATE_BUILD } from '../core/World.ts'
import { seedScenario } from '../scenario.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { OpponentAI } from '../ai/opponent.ts'
import { applyCommand } from '../net/apply.ts'
import { placeStructure } from '../world/construction.ts'
import { BUILDING_TYPE_BY_KIND } from '../world/construction.ts'
import { STEP } from './setup.ts'
import { suite, test, assert } from './harness.ts'

suite('ai-construction: stalled builds resume')

function makeWorld(faction: string): World {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new MovementSystemImpl())
  seedScenario(world, faction as never, faction as never)
  return world
}

function hallOf(world: World, team: 0 | 1): number {
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_HALL) return id
  }
  throw new Error('no hall')
}

/** Place a barracks near the hall, trying ring offsets like the AI's build(). */
function placeBarracksNearHall(world: World, team: 0 | 1): number {
  world.gold[team] = Math.max(world.gold[team], 1000)
  world.wood[team] = Math.max(world.wood[team], 1000)
  const hall = hallOf(world, team)
  const hx = world.positionX[hall]
  const hz = world.positionZ[hall]
  for (let k = 0; k < 30; k += 1) {
    const ring = Math.floor(k / 10)
    const angle = (k % 10) * 0.628 + ring * 0.3
    const r = 14 + ring * 4
    const placed = placeStructure(
      world, team, BUILDING_TYPE_BY_KIND[KIND_BARRACKS],
      hx + Math.cos(angle) * r, hz + Math.sin(angle) * r,
    )
    if (placed.ok) return placed.id
  }
  throw new Error('no free spot for barracks')
}

/** Count melee/ranged training onsets for team 0 (same metric as ai-melee). */
function countTrained(faction: string, minutes: number): { melee: number; ranged: number } {
  const world = makeWorld(faction)
  world.registerSystem(new OpponentAI(0, 'normal', 'expander'))
  world.registerSystem(new OpponentAI(1, 'normal', 'expander'))
  let melee = 0
  let ranged = 0
  const wasMelee = new Map<number, boolean>()
  const wasRanged = new Map<number, boolean>()
  const maxSteps = 60 * 60 * minutes
  for (let s = 0; s < maxSteps && world.winner === -1; s++) {
    world.update(STEP)
    for (const id of world.entities.keys()) {
      if (world.team[id] !== 0) continue
      const kind = world.kind[id]
      if (kind === KIND_BARRACKS) {
        const training = world.trainKind[id] === KIND_MELEE
        if (training && !wasMelee.get(id)) melee += 1
        wasMelee.set(id, training)
      } else if (kind === KIND_ARCHERY) {
        const training = world.trainKind[id] === KIND_RANGED
        if (training && !wasRanged.get(id)) ranged += 1
        wasRanged.set(id, training)
      }
    }
  }
  return { melee, ranged }
}

test('supervisor re-arms a builder on a stalled barracks', () => {
  const world = makeWorld('orc')
  const ai = new OpponentAI(0, 'normal', 'expander')
  // Stall a barracks mid-build with nobody on it.
  const site = placeBarracksNearHall(world, 0)
  world.buildProgress[site] = Math.floor(world.buildTotal[site] / 2)

  ai.update(world, 999) // force a think tick

  let resumed = false
  for (const id of world.entities.keys()) {
    if (world.team[id] !== 0) continue
    if (world.state[id] === STATE_BUILD && world.targetId[id] === site) resumed = true
  }
  assert(resumed, 'a worker must be re-assigned to the stalled barracks')
})

test('orc and elf expanders complete the barracks and train melee', () => {
  for (const faction of ['orc', 'elf']) {
    const { melee, ranged } = countTrained(faction, 8)
    assert(
      melee >= 4,
      `${faction} starved its barracks: only ${melee} melee trained in 8 minutes (ranged ${ranged})`,
    )
  }
})

test('orc melee training counts are deterministic', () => {
  const a = countTrained('orc', 5)
  const b = countTrained('orc', 5)
  assert(
    a.melee === b.melee && a.ranged === b.ranged,
    `training counts must be deterministic: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  )
})

test("applyCommand 'build' with siteId resumes instead of placing", () => {
  const world = makeWorld('human')
  const site = placeBarracksNearHall(world, 0)
  world.buildProgress[site] = 1
  const before = world.entities.size

  let worker = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === 0 && world.kind[id] === KIND_WORKER) { worker = id; break }
  }
  assert(worker !== -1, 'need a worker')

  applyCommand(world, {
    type: 'build', step: 0, workerId: worker,
    building: BUILDING_TYPE_BY_KIND[KIND_BARRACKS], x: 0, z: 0, siteId: site,
  })

  assert(world.entities.size === before, 'resume must not place a new structure')
  assert(
    world.state[worker] === STATE_BUILD && world.targetId[worker] === site,
    'worker must be ordered back to the stalled site',
  )
})

test("applyCommand 'build' with a completed siteId is a no-op", () => {
  const world = makeWorld('human')
  const hall = hallOf(world, 0)
  const before = world.entities.size
  let worker = -1
  for (const id of world.entities.keys()) {
    if (world.team[id] === 0 && world.kind[id] === KIND_WORKER) { worker = id; break }
  }
  assert(worker !== -1, 'need a worker')

  applyCommand(world, {
    type: 'build', step: 0, workerId: worker,
    building: BUILDING_TYPE_BY_KIND[KIND_BARRACKS], x: 0, z: 0, siteId: hall,
  })

  assert(world.entities.size === before, 'completed siteId must not place a new structure')
})
