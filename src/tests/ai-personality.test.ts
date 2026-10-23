/**
 * AI personality tests — verifies that the aggressor / defender / expander
 * personalities actually change AI decisions (resolved tuning + behavior).
 * Headless and deterministic.
 */
import { World, HARVEST_OFF, KIND_HALL, KIND_MELEE, KIND_RANGED, KIND_WORKER, STATE_ATTACKMOVE, STATE_MOVE, TEAM_ENEMY, TEAM_PLAYER } from '../core/World.ts'
import { OpponentAI, type AIDifficulty, type AIPersonality } from '../ai/opponent.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
import { makeWorld, stepWorld } from './setup.ts'

function tuning(diff: AIDifficulty, pers: AIPersonality) {
  return new OpponentAI(TEAM_ENEMY, diff, pers).decisionTuning()
}

suite('ai-personality: tuning')

test('constructor stores difficulty and personality', () => {
  const ai = new OpponentAI(TEAM_ENEMY, 'hard', 'aggressor')
  assertEqual(ai.difficulty, 'hard', 'difficulty stored')
  assertEqual(ai.personality, 'aggressor', 'personality stored')
})

test('defaults match the old behavior (normal/expander)', () => {
  const ai = new OpponentAI(TEAM_ENEMY)
  assertEqual(ai.difficulty, 'normal', 'default difficulty')
  assertEqual(ai.personality, 'expander', 'default personality')
  assertEqual(ai.decisionTuning().attackArmy, 6, 'expander attacks a touch later than base 5')
})

test('attack threshold orders aggressor <= expander < defender', () => {
  const a = tuning('normal', 'aggressor').attackArmy
  const e = tuning('normal', 'expander').attackArmy
  const d = tuning('normal', 'defender').attackArmy
  assert(a <= e && e < d, `expected ${a} <= ${e} < ${d}`)
})

test('aggressor never expands; expander expands earlier than base', () => {
  const a = tuning('normal', 'aggressor').expansionAtSec
  const e = tuning('normal', 'expander').expansionAtSec
  const d = tuning('normal', 'defender').expansionAtSec
  assert(a === Infinity, 'aggressor never builds a second hall')
  assert(e < 300, 'expander expands before the old 300s baseline')
  assert(d > 300, 'defender expands after the old baseline')
})

test('aggressor rushes economy-to-army faster than defender', () => {
  const a = tuning('normal', 'aggressor')
  const d = tuning('normal', 'defender')
  assert(a.workersBeforeArmy < d.workersBeforeArmy, 'aggressor builds barracks with fewer workers')
  assert(a.defenseRadius < d.defenseRadius, 'aggressor defends a smaller radius')
})

suite('ai-personality: behavior')

/** Reveal the player hall to the enemy AI and hand it `count` idle melee units. */
function armedScenario(count: number): { world: World; soldiers: number[] } {
  const world = makeWorld()
  // Mid-game scenario: the First Bell has rung (the AI only attacks post-bell).
  world.matchTime = 200
  world.bellsRung[0] = 1
  let playerHallX = 0
  let playerHallZ = 0
  let enemyHallX = 0
  let enemyHallZ = 0
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== KIND_HALL) continue
    if (world.team[id] === TEAM_PLAYER) {
      playerHallX = world.positionX[id]
      playerHallZ = world.positionZ[id]
    } else {
      enemyHallX = world.positionX[id]
      enemyHallZ = world.positionZ[id]
    }
  }
  // Enemy AI has scouted the player base.
  world.fog[TEAM_ENEMY].reveal(playerHallX, playerHallZ, 40)
  const soldiers: number[] = []
  for (let i = 0; i < count; i += 1) {
    soldiers.push(world.spawnUnit('melee', TEAM_ENEMY, enemyHallX + 5 + i, enemyHallZ + 5).id)
  }
  return { world, soldiers }
}

function attackersOf(world: World, soldiers: number[]): number {
  let n = 0
  for (const id of soldiers) {
    if (world.state[id] === STATE_ATTACKMOVE) n += 1
  }
  return n
}

test('aggressor attacks with a full wave', () => {
  const { world, soldiers } = armedScenario(6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 6, `aggressor should send all 6 soldiers, sent ${n}`)
})

test('aggressor holds a sub-threshold force', () => {
  const { world, soldiers } = armedScenario(5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'aggressor').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 0, `aggressor with 5 soldiers should wait for 6, sent ${n}`)
})

test('defender holds back the same army', () => {
  const { world, soldiers } = armedScenario(6)
  new OpponentAI(TEAM_ENEMY, 'normal', 'defender').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 0, `defender should hold its 6 soldiers, sent ${n}`)
})

test('expander sits between the two', () => {
  const { world, soldiers } = armedScenario(5)
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  const n = attackersOf(world, soldiers)
  assertEqual(n, 0, `expander with 5 soldiers should not attack yet (needs 6), sent ${n}`)
})

test('expander attacks once the army is big enough', () => {
  const { world, soldiers } = armedScenario(8)
  new OpponentAI(TEAM_ENEMY, 'normal', 'expander').update(world, 5)
  const n = attackersOf(world, soldiers)
  assert(n >= 6, `expander should attack with 8 soldiers, sent ${n}`)
})

suite('ai-micro: worker evacuation')

interface RaidSetup {
  world: World
  ai: OpponentAI
  workers: number[]
  raiders: number[]
  hx: number
  hz: number
}

/** AI base with two player raiders inside its defense radius. */
function raidSetup(): RaidSetup {
  const world = makeWorld()
  let hx = 0
  let hz = 0
  const workers: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_ENEMY) {
      hx = world.positionX[id]
      hz = world.positionZ[id]
    }
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_ENEMY) workers.push(id)
  }
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  const raiders = [
    world.spawnUnit('melee', TEAM_PLAYER, hx - 10, hz).id,
    world.spawnUnit('melee', TEAM_PLAYER, hx - 12, hz + 4).id,
  ]
  // Run the world systems so the spatial hash is populated and the vision
  // system reveals the AI's own base (as it does every frame in-game).
  stepWorld(world, 5)
  return { world, ai, workers, raiders, hx, hz }
}

test('workers flee when raiders enter the base', () => {
  const { world, ai, workers } = raidSetup()
  ai.update(world, 2) // normal thinkEvery = 1.0s, so the think tick fires
  let fled = 0
  for (const w of workers) {
    if (world.state[w] === STATE_MOVE && world.harvestKind[w] === HARVEST_OFF) fled += 1
  }
  assertEqual(fled, workers.length, `all ${workers.length} workers should flee, ${fled} fled`)
})

test('evacuated workers rally behind the hall, away from the threat', () => {
  const { world, ai, workers, hx } = raidSetup()
  ai.update(world, 2)
  // The nearest raider sits at (hx - 10, hz): the rally point must be past the hall.
  for (const w of workers) {
    assert(
      world.targetX[w] > hx,
      `worker should flee away from the raiders (targetX ${world.targetX[w]} <= hall ${hx})`,
    )
  }
})

test('workers resume harvesting once the raid is over', () => {
  const { world, ai, workers, raiders } = raidSetup()
  ai.update(world, 2)
  for (const r of raiders) world.removeEntityById(r) // Raid over.
  // Let the AI think and the workers walk back. The scout may take one worker.
  for (let i = 0; i < 30; i += 1) {
    ai.update(world, 1)
    stepWorld(world, 60)
  }
  let rearmed = 0
  for (const w of workers) {
    if (world.harvestKind[w] !== HARVEST_OFF) rearmed += 1
  }
  assert(rearmed >= 3, `at least 3 workers should be back on resources, ${rearmed} rearmed`)
})

test('flee orders are deterministic', () => {
  const run = (): string => {
    const { world, ai, workers } = raidSetup()
    ai.update(world, 2)
    return workers
      .map((w) => `${world.targetX[w].toFixed(3)},${world.targetZ[w].toFixed(3)}`)
      .join('|')
  }
  assertEqual(run(), run(), 'the same raid must produce identical flee orders')
})

/** Enemy workers of a fresh scenario world, in spawn order. */
function placedWorkers(world: World): number[] {
  const workers: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_ENEMY) workers.push(id)
  }
  return workers
}

function place(world: World, id: number, x: number, z: number): void {
  world.positionX[id] = x
  world.positionZ[id] = z
}

test('a raider beyond the hall radius evacuates only the workers near it', () => {
  // Enemy hall at (40,40), defense radius 28 — but the far wood line sits
  // ~31 out. The old hall-centric trigger never saw a raider working it:
  // nothing evacuated at all. Per-worker evaluation (post-ring defense
  // audit 2026-10-23, Finding 3) keys on the worker instead.
  const world = makeWorld()
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40) // Player hall scouted: no scout is sent.
  const [near, far, spare1, spare2] = placedWorkers(world)
  place(world, near, 50, 13) // far wood line
  place(world, far, 18, 34) // far gold line, 43 from the raider
  place(world, spare1, 24, 30)
  place(world, spare2, 26, 38)
  world.spawnUnit('melee', TEAM_PLAYER, 56, 13) // 6 from `near`, 31.4 from the hall
  stepWorld(world, 5)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 2)
  assert(
    world.state[near] === STATE_MOVE && world.harvestKind[near] === HARVEST_OFF,
    'the worker next to the raider flees',
  )
  assert(world.harvestKind[far] !== HARVEST_OFF, 'the distant gold worker keeps gathering')
  assert(world.harvestKind[spare1] !== HARVEST_OFF, 'mid-base worker 1 keeps gathering')
  assert(world.harvestKind[spare2] !== HARVEST_OFF, 'mid-base worker 2 keeps gathering')
})

test('release is per-worker: a parked enemy holds only the workers near it', () => {
  // Two separated threats: a melee raider by the wood-line worker, and an
  // unarmed enemy WORKER parked by the gold-line worker (harvest disarmed
  // so the gather system never walks it off its post). The parked worker
  // pins the shipped predicate semantics (the scout case): enemy workers
  // still count as threats — but under per-worker evaluation its hold is
  // local, and when the raider is gone, the wood-line worker is released
  // and re-armed even though an enemy still stands in the base. The old
  // global release failed both directions: one enemy anywhere inside the
  // hall radius held every evacuee out indefinitely (the evacuation
  // freeze), and clearing it released everyone at once.
  const world = makeWorld()
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40) // Player hall scouted: no scout is sent.
  const [spare1, held, spare2, released] = placedWorkers(world)
  place(world, spare1, 40, 52)
  place(world, held, 18, 34) // gold line
  place(world, spare2, 44, 50)
  place(world, released, 54, 16) // far wood line
  const raider = world.spawnUnit('melee', TEAM_PLAYER, 57, 13).id // 4.2 from `released`
  const parked = world.spawnUnit('worker', TEAM_PLAYER, 14, 30).id // 5.7 from `held`
  world.harvestKind[parked] = HARVEST_OFF // Parked for real: never auto-assigned.
  stepWorld(world, 5)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  ai.update(world, 2)
  assert(
    world.state[released] === STATE_MOVE && world.harvestKind[released] === HARVEST_OFF,
    'wood-line worker flees its raider',
  )
  assert(
    world.state[held] === STATE_MOVE && world.harvestKind[held] === HARVEST_OFF,
    'gold-line worker flees the parked enemy worker',
  )
  // The raider is destroyed; the parked scout stays where it stands.
  world.removeEntityById(raider)
  const nearestEnemyDist = (id: number): number => {
    let best = Infinity
    for (const e of world.entities.keys()) {
      if (world.team[e] !== TEAM_PLAYER) continue
      const k = world.kind[e]
      if (k !== KIND_WORKER && k !== KIND_MELEE && k !== KIND_RANGED) continue
      const d = Math.hypot(world.positionX[e] - world.positionX[id], world.positionZ[e] - world.positionZ[id])
      if (d < best) best = d
    }
    return best
  }
  let heldOffSamples = 0
  let releasedArmedLateSamples = 0
  let phantomHolds = 0
  for (let i = 0; i < 30; i += 1) {
    ai.update(world, 1)
    stepWorld(world, 60)
    if (world.harvestKind[held] === HARVEST_OFF) heldOffSamples += 1
    if (i >= 15) {
      if (world.harvestKind[released] !== HARVEST_OFF) releasedArmedLateSamples += 1
      // Phantom hold: evacuated while no enemy is within the trigger
      // radius — the old global release's signature failure.
      if (world.harvestKind[released] === HARVEST_OFF && nearestEnemyDist(released) > 32) {
        phantomHolds += 1
      }
    }
  }
  assertEqual(phantomHolds, 0, 'the released worker is never held out by a distant enemy')
  assert(
    releasedArmedLateSamples >= 5,
    `the released worker is back on resources in the late samples (${releasedArmedLateSamples}/15)`,
  )
  assert(
    heldOffSamples >= 5,
    `the held worker keeps being flushed by its parked neighbor (${heldOffSamples}/30 samples off)`,
  )
})

interface PinSetup {
  world: World
  ai: OpponentAI
  workers: number[]
  raider: number
  rx: number
  rz: number
}

/**
 * Siege geometry that pinned the hall-anchored rally: a raider 12.7 from
 * the hall. The rally (16 behind the hall, away from the threat) lands
 * 28.7 from the raider — inside FLEE_TRIGGER — so an evacuee that
 * reached it was still within trigger range of the threat and was
 * re-ordered every think for as long as the siege lasted: the fleeing
 * set was an absorbing state (human-v-undead audit 2026-10-23, cause 1:
 * 11 of 12 workers pinned by two besiegers, working seconds down
 * 23-35%).
 */
function pinSetup(): PinSetup {
  const world = makeWorld()
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40) // Player hall scouted: no scout is sent.
  const workers = placedWorkers(world)
  place(world, workers[0], 36, 30)
  place(world, workers[1], 30, 38)
  place(world, workers[2], 44, 34)
  place(world, workers[3], 34, 44)
  const rx = 31
  const rz = 31 // 12.7 from the enemy hall at (40,40)
  const raider = world.spawnUnit('melee', TEAM_PLAYER, rx, rz).id
  stepWorld(world, 5)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  return { world, ai, workers, raider, rx, rz }
}

test('a rally inside the threat radius is extended until it clears the radius', () => {
  const { world, ai, workers, rx, rz } = pinSetup()
  ai.update(world, 2)
  for (const w of workers) {
    assert(
      world.state[w] === STATE_MOVE && world.harvestKind[w] === HARVEST_OFF,
      'every worker inside the radius still evacuates',
    )
    const d = Math.hypot(world.targetX[w] - rx, world.targetZ[w] - rz)
    assert(
      d > 32,
      `flee destination must clear the threat's trigger radius (d=${d.toFixed(1)})`,
    )
  }
})

test('a permanent siege cannot hold the worker line forever', () => {
  // The threat never leaves: an unarmed enemy worker parked at the pin
  // point (the audit's freeze agent — it flushes the line but cannot
  // kill it). Bound asserted: evacuees cycle out and back instead of
  // accumulating at the rally — over the settled window (samples 5-40)
  // the staged crew is harvest-off in at most 80% of worker-samples
  // (the absorbing pin reads ~100%), and the crew is still cycling in
  // the late window, never parked for good.
  const world = makeWorld()
  world.fog[TEAM_ENEMY].reveal(-40, -40, 40)
  const workers = placedWorkers(world)
  place(world, workers[0], 36, 30)
  place(world, workers[1], 30, 38)
  place(world, workers[2], 44, 34)
  place(world, workers[3], 34, 44)
  const parked = world.spawnUnit('worker', TEAM_PLAYER, 31, 31).id
  world.harvestKind[parked] = HARVEST_OFF // Parked for real: never auto-assigned.
  stepWorld(world, 5)
  const ai = new OpponentAI(TEAM_ENEMY, 'normal', 'expander')
  let offSamples = 0
  let totalSamples = 0
  let cyclingLateSamples = 0
  for (let i = 0; i < 60; i += 1) {
    ai.update(world, 1)
    stepWorld(world, 60)
    let anyArmed = false
    for (const w of workers) {
      if (world.harvestKind[w] === HARVEST_OFF) {
        if (i >= 5 && i < 40) offSamples += 1
      } else {
        anyArmed = true
      }
    }
    if (i >= 5 && i < 40) totalSamples += workers.length
    if (i >= 40 && anyArmed) cyclingLateSamples += 1
  }
  assert(
    offSamples <= totalSamples * 0.8,
    `siege flee burden must stay bounded (${offSamples}/${totalSamples} worker-samples off, pin reads ~100%)`,
  )
  assert(
    cyclingLateSamples >= 8,
    `the crew keeps cycling back to work late in the siege (${cyclingLateSamples}/20 samples with an armed worker)`,
  )
})

test('workers recover once a pinning siege lifts', () => {
  const { world, ai, workers, raider } = pinSetup()
  ai.update(world, 2)
  world.removeEntityById(raider) // Siege over.
  for (let i = 0; i < 30; i += 1) {
    ai.update(world, 1)
    stepWorld(world, 60)
  }
  let rearmed = 0
  for (const w of workers) {
    if (world.harvestKind[w] !== HARVEST_OFF) rearmed += 1
  }
  assert(rearmed >= 3, `at least 3 workers should be back on resources, ${rearmed} rearmed`)
})
