/**
 * State-coverage guards — the tests that keep the 2026-10-24 audit hole
 * from reopening.
 *
 * The hole: World's sim state was enumerated in four hand-maintained
 * lists of three lengths. hashWorldState/snapshotWorld covered 37 of 49
 * typed arrays, save/load dropped reanimate timers and resume targets,
 * and no test could see the drift. Now all serializers derive from
 * core/state-registry.ts, and this suite reflects over a live World to
 * prove the registry is complete, proves the hash is sensitive to every
 * previously-missed field, and proves snapshot + save/load round-trips
 * on NON-DEFAULT state (the old bit-exact test only exercised a world
 * whose uncovered fields sat at constructor defaults).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual } from './harness.ts'
import { World, KIND_SHRINE } from '../core/World.ts'
import {
  WORLD_ENTITY_ARRAYS,
  WORLD_TEAM_ARRAYS,
  WORLD_SCALARS,
  WORLD_EXCLUDED_FIELDS,
} from '../core/state-registry.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { hashWorldState } from '../net/hash.ts'
import { snapshotWorld, restoreWorld } from '../net/snapshot.ts'
import {
  serializeWorld,
  deserializeWorld,
  type WorldSave,
} from '../session/save-load.ts'

// ---------------------------------------------------------------------------
// (a) Registry completeness — reflection over a live World
// ---------------------------------------------------------------------------

suite('state coverage: registry completeness')

test('every typed array on World is registered as an entity array', () => {
  const world = new World()
  const registered = new Set(WORLD_ENTITY_ARRAYS.map((s) => s.name))
  const missing: string[] = []
  for (const key of Object.keys(world)) {
    const v = (world as unknown as Record<string, unknown>)[key]
    if (ArrayBuffer.isView(v) && !registered.has(key)) missing.push(key)
  }
  assertEqual(missing.length, 0, `unregistered typed arrays: ${missing.join(', ')}`)
})

test('every World field is registered or explicitly excluded', () => {
  const world = new World()
  const rec = world as unknown as Record<string, unknown>
  const entityNames = new Set(WORLD_ENTITY_ARRAYS.map((s) => s.name))
  const teamNames = new Set<string>(WORLD_TEAM_ARRAYS)
  const scalarNames = new Set(WORLD_SCALARS.map((s) => s.name))
  const unclassified: string[] = []
  for (const key of Object.keys(world)) {
    const v = rec[key]
    if (ArrayBuffer.isView(v)) {
      if (!entityNames.has(key)) unclassified.push(`${key} (typed array)`)
    } else if (Array.isArray(v)) {
      if (!teamNames.has(key) && !(key in WORLD_EXCLUDED_FIELDS)) {
        unclassified.push(`${key} (plain array)`)
      }
    } else if (typeof v === 'number') {
      if (!scalarNames.has(key) && !(key in WORLD_EXCLUDED_FIELDS)) {
        unclassified.push(`${key} (scalar)`)
      }
    } else if (!(key in WORLD_EXCLUDED_FIELDS)) {
      unclassified.push(`${key} (${typeof v})`)
    }
  }
  assertEqual(
    unclassified.length,
    0,
    `World fields neither registered nor excluded: ${unclassified.join(', ')}`,
  )
})

test('registry entries name real World fields of the right kind', () => {
  const world = new World()
  const rec = world as unknown as Record<string, unknown>
  const ctors = {
    f32: Float32Array,
    u8: Uint8Array,
    i8: Int8Array,
    i32: Int32Array,
  } as const
  for (const spec of WORLD_ENTITY_ARRAYS) {
    const v = rec[spec.name]
    assert(
      v instanceof ctors[spec.kind],
      `${spec.name} should be a ${spec.kind} array`,
    )
  }
  for (const name of WORLD_TEAM_ARRAYS) {
    const v = rec[name]
    assert(
      Array.isArray(v) && v.every((x) => typeof x === 'number'),
      `${name} should be a per-team number array`,
    )
  }
  for (const spec of WORLD_SCALARS) {
    assert(typeof rec[spec.name] === 'number', `${spec.name} should be a number`)
  }
  for (const key of Object.keys(WORLD_EXCLUDED_FIELDS)) {
    assert(key in world, `exclusion names a real World field: ${key}`)
  }
})

test('registry has no duplicates or overlaps', () => {
  const all = [
    ...WORLD_ENTITY_ARRAYS.map((s) => s.name),
    ...WORLD_TEAM_ARRAYS,
    ...WORLD_SCALARS.map((s) => s.name),
  ]
  assertEqual(new Set(all).size, all.length, 'a field is registered twice')
  for (const name of all) {
    assert(!(name in WORLD_EXCLUDED_FIELDS), `${name} is both registered and excluded`)
  }
})

test('save-window flags mark exactly the non-entity-indexed arrays', () => {
  const full = WORLD_ENTITY_ARRAYS.filter((s) => s.saveWindow === 'full')
    .map((s) => s.name)
    .sort()
  assertEqual(
    full.join(','),
    'bellsRung,trainQueueKind',
    'only trainQueueKind (id*7+slot) and bellsRung (fixed 3) serialize whole',
  )
})

// ---------------------------------------------------------------------------
// (b) Hash sensitivity — every previously-missed field flips the hash
// ---------------------------------------------------------------------------

suite('state coverage: hash sensitivity')

test('hash sees every field the pre-registry hash missed', () => {
  const w = makeWorld()
  const live = [...w.entities.keys()][0]
  const base = hashWorldState(w)
  // [label, perturb, restore] — restore must return the hash to base,
  // which also proves the perturbation (not drift) caused the change.
  const cases: Array<[string, () => void, () => void]> = []
  const num = (
    label: string,
    get: () => number,
    set: (v: number) => void,
    delta: number,
  ): void => {
    const old = get()
    cases.push([label, () => set(old + delta), () => set(old)])
  }
  // Entity arrays missed by hash + snapshot (audit code-health §1).
  num('bellsRung', () => w.bellsRung[1], (v) => { w.bellsRung[1] = v }, 1)
  num('buildAuto', () => w.buildAuto[live], (v) => { w.buildAuto[live] = v }, 1)
  num('carryMax', () => w.carryMax[live], (v) => { w.carryMax[live] = v }, 5)
  num('lastCombatTick', () => w.lastCombatTick[live], (v) => { w.lastCombatTick[live] = v }, 7)
  num('militiaUntil', () => w.militiaUntil[live], (v) => { w.militiaUntil[live] = v }, 123.5)
  num('momentumTicks', () => w.momentumTicks[live], (v) => { w.momentumTicks[live] = v }, 3)
  num('reanimateTicks', () => w.reanimateTicks[live], (v) => { w.reanimateTicks[live] = v }, 11)
  num('shrineHeld', () => w.shrineHeld[live], (v) => { w.shrineHeld[live] = v }, 1)
  num('tier', () => w.tier[live], (v) => { w.tier[live] = v }, 1)
  num('upgradeLeft', () => w.upgradeLeft[live], (v) => { w.upgradeLeft[live] = v }, 2.5)
  // Per-team fields missed by the hash (audit perf §4.3).
  num('victoryPoints', () => w.victoryPoints[0], (v) => { w.victoryPoints[0] = v }, -37)
  num('soulAsh', () => w.soulAsh[1], (v) => { w.soulAsh[1] = v }, 5)
  num('warCharge', () => w.warCharge[0], (v) => { w.warCharge[0] = v }, 42)
  num('warLastTick', () => w.warLastTick[0], (v) => { w.warLastTick[0] = v }, 99)
  num('rallyKind', () => w.rallyKind[0], (v) => { w.rallyKind[0] = v }, 2)
  num('rallyUntil', () => w.rallyUntil[0], (v) => { w.rallyUntil[0] = v }, 55.5)
  num('militiaCooldown', () => w.militiaCooldown[0], (v) => { w.militiaCooldown[0] = v }, 77)
  // Scalars the old hash omitted (it covered season + winner only).
  num('tick', () => w.tick, (v) => { w.tick = v }, 1)
  num('matchTime', () => w.matchTime, (v) => { w.matchTime = v }, 12.25)
  num('season', () => w.season, (v) => { w.season = v }, 1)

  for (const [label, perturb, restore] of cases) {
    perturb()
    assert(hashWorldState(w) !== base, `hash must change when ${label} changes`)
    restore()
    assertEqual(hashWorldState(w), base, `hash must return to base after ${label} restore`)
  }
  console.log(`  hash sensitivity: ${cases.length} previously-missed fields verified`)
})

// ---------------------------------------------------------------------------
// (c) Snapshot round-trip on non-default state + post-resync drill
// ---------------------------------------------------------------------------

suite('state coverage: snapshot resync')

test('snapshot/restore is hash-exact on non-default state', () => {
  const a = makeWorld()
  stepWorld(a, 300)
  // Removal churn → non-empty free-id stack with a non-rebuild pop order.
  const ids = [...a.entities.keys()]
  a.removeEntityById(ids[2])
  a.removeEntityById(ids[5])
  const live = [...a.entities.keys()][0]
  const shrine = [...a.entities.keys()].find((id) => a.kind[id] === KIND_SHRINE)
  assert(shrine !== undefined, 'scenario seeds a shrine')
  // Previously-missed state, all non-default:
  a.victoryPoints = [640, 915]
  a.shrineHeld[shrine!] = 1
  a.season = 1
  a.matchTime = 372.5
  a.wildHeat = [3.25, 0]
  a.wildSiteX = [12, -4]
  a.wildSiteZ = [-8, 22]
  a.wildWorker = [live, -1]
  a.soulAsh = [17, 3]
  a.warCharge = [55, 80]
  a.warLastTick = [290, 12]
  a.rallyKind = [1, 0]
  a.rallyUntil = [400, 0]
  a.militiaCooldown = [500, 0]
  a.meleeDmgLvl = [2, 1]
  a.reanimateTicks[live] = 400
  a.momentumTicks[live] = 9
  a.lastCombatTick[live] = 250
  a.carryMax[live] = 20
  a.buildAuto[live] = 1
  a.militiaUntil[live] = 999.5
  a.tier[live] = 3
  a.upgradeLeft[live] = 4.5
  a.bellsRung[0] = 1
  a.bellsRung[1] = 1

  const before = hashWorldState(a)
  const bytes = snapshotWorld(a)
  const b = makeWorld()
  stepWorld(b, 77) // dirty the target with a different history first
  restoreWorld(b, bytes)

  assertEqual(hashWorldState(b), before, 'restored hash must match on non-default state')
  assertEqual(b.victoryPoints[0], 640, 'VP restored')
  assertEqual(b.season, 1, 'season restored')
  assertEqual(b.tick, a.tick, 'tick restored')
  assertEqual(b.matchTime, 372.5, 'matchTime restored')
  assertEqual(b.reanimateTicks[live], 400, 'reanimate timer restored')
  assertEqual(b.shrineHeld[shrine!], 1, 'shrine holder restored')
  assertEqual(b.bellsRung[1], 1, 'bells restored')
  assertEqual(b.getFreeIdCount(), a.getFreeIdCount(), 'free-id stack restored')
  // Resync drill: 120 further ticks on both must stay bit-identical —
  // the pre-fix snapshot re-diverged here (season/wild/VP went stale).
  stepWorld(a, 120)
  stepWorld(b, 120)
  assertEqual(hashWorldState(b), hashWorldState(a), 'post-resync ticks stay identical')
})

// ---------------------------------------------------------------------------
// (d) Save/load round-trip — reanimate crumble + resume targets + research
// ---------------------------------------------------------------------------

suite('state coverage: save/load fidelity')

test('save/load preserves reanimate timers, resume targets, research', () => {
  const a = makeWorld()
  const live = [...a.entities.keys()][0]
  a.reanimateTicks[live] = 30
  a.resumeX[live] = 12.5
  a.resumeZ[live] = -7.25
  a.meleeDmgLvl = [2, 0]
  a.meleeHpLvl = [0, 1]
  a.rangedDmgLvl = [3, 3]
  // Round-trip through JSON, the way writeSave/readSave actually persist.
  const save = JSON.parse(JSON.stringify(serializeWorld(a, 0, []))) as WorldSave
  const b = makeWorld()
  deserializeWorld(b, save)
  assertEqual(b.reanimateTicks[live], 30, 'reanimate timer survives save/load')
  assertEqual(b.resumeX[live], 12.5, 'resumeX survives save/load')
  assertEqual(b.resumeZ[live], -7.25, 'resumeZ survives save/load')
  assertEqual(b.meleeDmgLvl[0], 2, 'research levels survive save/load')
  assertEqual(b.rangedDmgLvl[1], 3, 'ranged research survives save/load')
  // The actual bug: before the fix the loaded timer read 0 ("not
  // reanimated") and the unit NEVER crumbled.
  stepWorld(b, 29)
  assert(b.entities.has(live), 'reanimated unit alive at 29 ticks')
  stepWorld(b, 2)
  assert(!b.entities.has(live), 'reanimated unit crumbles on schedule after load')
})

// ---------------------------------------------------------------------------
// Runner completeness — run.ts must import every test file on disk
// ---------------------------------------------------------------------------

suite('state coverage: test runner completeness')

function locateSrcDir(): string {
  const candidates = [
    'src', // cwd = repo root (npm test)
    fileURLToPath(new URL('../../src', import.meta.url)), // bundle in node_modules/.cache
    '/home/hatch/workspace/kingdoms-rts/src',
  ]
  for (const c of candidates) {
    if (existsSync(`${c}/tests/run.ts`)) return c
  }
  throw new Error('cannot locate src dir')
}

test('run.ts imports every .test.ts file on disk', () => {
  const src = locateSrcDir()
  const runSrc = readFileSync(`${src}/tests/run.ts`, 'utf8')
  const missing: string[] = []
  for (const dir of ['tests', 'net'] as const) {
    for (const f of readdirSync(`${src}/${dir}`)) {
      if (!f.endsWith('.test.ts')) continue
      const spec = dir === 'tests' ? `./${f}` : `../net/${f}`
      if (!runSrc.includes(`'${spec}'`)) missing.push(`${dir}/${f}`)
    }
  }
  assertEqual(
    missing.length,
    0,
    `test files on disk but not imported by run.ts: ${missing.join(', ')}`,
  )
})
