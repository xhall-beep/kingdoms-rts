/**
 * Player-seat grace tests — the softening variant (Montz, 2026-11-23).
 *
 * The W1+W2 grace (run-evidence/2026-11-21-softening/) fires only for
 * HUMAN seats (world.humanSeat: 1 = a human player occupies the seat,
 * 0 = AI). AI-vs-AI games never set the flag, so their forest and
 * sorties behave exactly as the shipped game — the farm-identity
 * property (V1) rests on this scoping, and these tests pin it at unit
 * level. The grace behavior itself (hold to the Second Bell, one
 * capped answer, First-Bell sorties, ungated emergency) is pinned in
 * opening-grace.test.ts; this file pins WHO it fires for.
 */
import {
  World,
  KIND_SHRINE,
  KIND_HALL,
  KIND_TREANT,
  STATE_ATTACKMOVE,
  TEAM_ENEMY,
  TEAM_PLAYER,
} from '../core/World.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { WILD_HEAT_THRESHOLD } from '../systems/living-wild.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'
import {
  serializeWorld,
  deserializeWorld,
} from '../session/save-load.ts'

suite('player-seat grace: the grace fires only for human seats')

// Treants are TEAM_NEUTRAL (spawnTreant) — they cannot be attributed by
// team. The spawn SITE is the per-team signal: the treant rises at the
// offending team's recorded harvest site, so count treants near it.
function treantCountNear(world: World, x: number, z: number): number {
  let n = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_TREANT) continue
    const dx = world.positionX[id] - x
    const dz = world.positionZ[id] - z
    if (dx * dx + dz * dz <= 4) n += 1
  }
  return n
}

/**
 * Stage a team over the heat threshold, deep in the grace window.
 * `heat` defaults to two full thresholds + 10 (the clamp case — an
 * unclamped deferral would answer with a burst); pass just over one
 * threshold where exactly one answer is the assertion.
 */
function overheat(world: World, team: 0 | 1, heat: number = WILD_HEAT_THRESHOLD * 2 + 10): void {
  const offender = world.spawnUnit('worker', team, team === 0 ? 5 : -5, 5)
  world.wildHeat[team] = heat
  world.wildSiteX[team] = team === 0 ? 5 : -5
  world.wildSiteZ[team] = 5
  world.wildWorker[team] = offender.id
}

test('W1: the AI seat still answers during grace — only the human forest holds', () => {
  const world = makeWorld()
  world.humanSeat = [1, 0] // team 0 human, team 1 AI
  overheat(world, TEAM_PLAYER)
  overheat(world, TEAM_ENEMY, WILD_HEAT_THRESHOLD + 10)
  stepWorld(world, 60) // 1 sim-second, deep in the grace window
  assertEqual(treantCountNear(world, 5, 5), 0, 'no treant for the human seat during grace')
  assertEqual(treantCountNear(world, -5, 5), 1, 'the AI seat answers at once, as shipped')
})

test('W1: with no human seat, both forests answer during grace (farm behavior)', () => {
  const world = makeWorld()
  world.humanSeat = [0, 0] // AI-vs-AI: the farm's configuration
  overheat(world, TEAM_PLAYER, WILD_HEAT_THRESHOLD + 10)
  overheat(world, TEAM_ENEMY, WILD_HEAT_THRESHOLD + 10)
  stepWorld(world, 60)
  assertEqual(treantCountNear(world, 5, 5), 1, 'team 0 answers with no human seat')
  assertEqual(treantCountNear(world, -5, 5), 1, 'team 1 answers with no human seat')
})

test('W1: with both seats human (PvP), both forests hold — symmetric', () => {
  const world = makeWorld()
  world.humanSeat = [1, 1]
  overheat(world, TEAM_PLAYER)
  overheat(world, TEAM_ENEMY)
  stepWorld(world, 60)
  assertEqual(treantCountNear(world, 5, 5), 0, 'team 0 forest holds in PvP')
  assertEqual(treantCountNear(world, -5, 5), 0, 'team 1 forest holds in PvP')
  world.matchTime = 400 // Past the Second Bell: both answers come due.
  stepWorld(world, 60)
  assertEqual(treantCountNear(world, 5, 5), 1, 'team 0 treant rises after the bell')
  assertEqual(treantCountNear(world, -5, 5), 1, 'team 1 treant rises after the bell')
})

interface ShrineStage {
  world: World
  soldiers: number[]
  sx: number
  sz: number
}

/**
 * Shrine staging (mirrors opening-grace.test.ts): the shrine is held
 * by `holder` (-1 = unheld). `count` idle enemy melee stage by their
 * hall (aggressor: garrison 1, attack threshold 6, so 10 staged = a
 * surplus of 4 for the normal branch).
 */
function shrineStage(count: number, holder: 0 | 1 | -1): ShrineStage {
  const world = makeWorld()
  let shrine = -1
  let hx = 0
  let hz = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) shrine = id
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_ENEMY) {
      hx = world.positionX[id]
      hz = world.positionZ[id]
    }
  }
  assert(shrine !== -1, 'scenario shrine exists')
  const sx = world.positionX[shrine]
  const sz = world.positionZ[shrine]
  world.shrineHeld[shrine] = holder
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, hx + 5 + i, hz + 5).id)
  }
  return { world, soldiers, sx, sz }
}

function sortiesOf(world: World, soldiers: number[], sx: number, sz: number): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] !== STATE_ATTACKMOVE) continue
    const dx = world.targetX[id] - sx
    const dz = world.targetZ[id] - sz
    if (dx * dx + dz * dz <= 4) n += 1
  }
  return n
}

function think(personality: AIPersonality, world: World, dt: number): void {
  new OpponentAI(TEAM_ENEMY, 'normal', personality).update(world, dt)
}

test('W2: a shrine held by an AI seat is contested during grace — no human victim', () => {
  // The farm's configuration: the holder (team 0) is an AI seat.
  const { world, soldiers, sx, sz } = shrineStage(10, TEAM_PLAYER)
  world.humanSeat = [0, 0]
  think('aggressor', world, 60)
  assertEqual(
    sortiesOf(world, soldiers, sx, sz),
    3,
    'the surplus sorties at once when the holder is an AI seat',
  )
})

test('W2: an unheld shrine is contested during grace', () => {
  const { world, soldiers, sx, sz } = shrineStage(10, -1)
  world.humanSeat = [1, 0]
  think('aggressor', world, 60)
  assertEqual(
    sortiesOf(world, soldiers, sx, sz),
    3,
    'no holder, no human victim — the surplus sorties at once',
  )
})

test('save/load carries the seats — and old saves load as no-grace', () => {
  const world = makeWorld()
  world.humanSeat = [1, 0]
  world.matchTime = 200 // inside the grace window
  const save = serializeWorld(world, 12000, [])
  const loaded = makeWorld()
  deserializeWorld(loaded, save)
  assertEqual(loaded.humanSeat[0], 1, 'human seat restored')
  assertEqual(loaded.humanSeat[1], 0, 'AI seat restored')
  assertEqual(loaded.matchTime, 200, 'match clock restored with the seats')
  // A save written before the flag existed carries no humanSeat field.
  const legacy = { ...save }
  delete (legacy as { humanSeat?: number[] }).humanSeat
  const legacyWorld = makeWorld()
  deserializeWorld(legacyWorld, legacy)
  assertEqual(legacyWorld.humanSeat[0], 0, 'legacy save loads as no human seat')
  assertEqual(legacyWorld.humanSeat[1], 0, 'legacy save loads as no AI-seat change')
})
