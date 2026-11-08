/**
 * Separation + surround ring pinning tests (audit item #2, Anchor note
 * 2026-11-07 AS AMENDED by the convergence-settlement addendum
 * 2026-11-07). Properties P1′–P14′ / NP1–NP4 / classes C1–C8, AC1–AC8
 * as staged here.
 *
 * HISTORY — the first implementation's two [CONFLICT] pins, kept
 * visible per the addendum's instruction: under the original
 * receiving rules (every participant receives the full positional
 * push), two tests in this file failed at EVERY CAP and were kept red
 * on purpose as the suite-level fingerprint of the §10 settlement
 * conflict:
 *   [CONFLICT] group ordered to one point all arrive — measured 0/6:
 *     the group parked in a hexagonal ring at dist 0.545 (stopDist
 *     0.5), moving = 1, bit-identical for 3,600 ticks, because
 *     steering's terminal step decays to zero at the stop ring and
 *     any sustained push p parks the group at stopDist + p.
 *   [CONFLICT] F1 workers ordered to one point come to rest
 *     separated — measured 0/5 rested (same jam).
 * The addendum (§A2) amended the receiving rules — tangential-only
 * for movers, destination relief exactly zero inside the band — and
 * retired those pins. They are replaced below by the AC1 park-trace
 * pin and the P2′ convergence pin, which stage the SAME scenes and
 * now assert arrival. The conflict is resolved by the amended design,
 * not deleted: this header and the AC1 test are its permanent record.
 */
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  STATE_IDLE,
  STATE_GATHER,
  STATE_HOLD,
  STATE_ATTACK,
  HARVEST_GOLD,
  HARVEST_OFF,
} from '../core/World.ts'
import {
  MovementSystemImpl,
  orderMove,
  orderHold,
  setSeparationEnabledForTests,
  setSeparationCapForTests,
  SEPARATION_CAP,
} from '../systems/movement.ts'
import { CombatSystemImpl, orderAttack } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import { SURROUND_OFFSETS } from '../core/Math.ts'
import { suite, test, assert, assertClose } from './harness.ts'
import { STEP } from './setup.ts'

suite('separation')

function bareWorld(withCombat = false): World {
  const world = new World()
  if (withCombat) world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  return world
}

/** Full production-order stack (the economy probes' recipe): workers
 * actually gather, return, build and muster here. */
function gatherWorld(): World {
  const world = new World()
  world.factionOfTeam = ['human' as never, 'human' as never]
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

function step(world: World, n: number): void {
  for (let i = 0; i < n; i++) world.update(STEP)
}

function minPairwise(world: World, ids: number[]): number {
  let m = Infinity
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = Math.hypot(
        world.positionX[ids[i]] - world.positionX[ids[j]],
        world.positionZ[ids[i]] - world.positionZ[ids[j]],
      )
      if (d < m) m = d
    }
  }
  return m
}

/**
 * NP1 park-signature scan (addendum §A2.3). Records a unit's distance
 * to a fixed destination point after every tick (record 0 is the
 * pre-run snapshot, taken after orders are issued), then counts
 * 600-tick windows in which the unit was moving with dist > stopDist
 * + 0.01 at every tick, its steering steps over the window sum to
 * > 1.0, and its net radial progress was < 0.01 — the signature of
 * the stable equilibrium the first implementation died on.
 */
class ParkScan {
  private dist: number[] = []
  private moving: number[] = []
  private stop: number[] = []
  private readonly speed: number

  constructor(speed: number) {
    this.speed = speed
  }

  record(world: World, id: number, destX: number, destZ: number): void {
    this.dist.push(
      Math.hypot(world.positionX[id] - destX, world.positionZ[id] - destZ),
    )
    this.moving.push(world.moving[id])
    this.stop.push(world.stopDist[id])
  }

  count(): number {
    const T = this.dist.length - 1
    if (T < 600) return 0
    // Prefix sums: Q over qualifying records, S over steering steps
    // (transition i lands on record i; step from record i−1's state).
    const Q = new Float64Array(T + 1)
    const S = new Float64Array(T + 1)
    for (let i = 0; i <= T; i++) {
      const q = this.moving[i] === 1 && this.dist[i] > this.stop[i] + 0.01 ? 1 : 0
      Q[i] = (i > 0 ? Q[i - 1] : 0) + q
      if (i === 0) {
        S[i] = 0
      } else {
        const st =
          this.moving[i - 1] === 1
            ? Math.min(this.speed * STEP, Math.max(0, this.dist[i - 1] - this.stop[i - 1]))
            : 0
        S[i] = S[i - 1] + st
      }
    }
    let parks = 0
    for (let s = 0; s + 600 <= T; s++) {
      const qualSum = Q[s + 599] - (s > 0 ? Q[s - 1] : 0)
      if (qualSum !== 600) continue
      const stepSum = S[s + 600] - S[s]
      if (stepSum <= 1.0) continue
      if (this.dist[s] - this.dist[s + 600] < 0.01) parks += 1
    }
    return parks
  }
}

/** Deterministic LCG for the fuzz scenes (tests are not the sim path,
 * but the scenes stay reproducible run-to-run anyway). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

// C1 + P1′/P2′/P3′: 12 mixed units coincident at one point, no orders.
// At-rest scene: no destinations, no motion — pair symmetry intact
// (§A2.4), centroid conservation owed here (P3′).
test('C1/P1/P2/P3 coincident mixed stack spreads in place by the deadline', () => {
  const world = bareWorld()
  const kinds = ['worker', 'melee', 'ranged'] as const
  const ids: number[] = []
  for (let i = 0; i < 12; i++) {
    ids.push(world.spawnUnit(kinds[i % 3], TEAM_PLAYER, 10, 10).id)
  }
  const crossings = new Map<string, number>()
  const above = new Map<string, boolean>()
  let reachTick = -1
  for (let t = 0; t < 645; t++) {
    world.update(STEP)
    if (reachTick < 0 && minPairwise(world, ids) >= 0.8) reachTick = t + 1
    if (reachTick > 0) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${i}:${j}`
          const d = Math.hypot(
            world.positionX[ids[i]] - world.positionX[ids[j]],
            world.positionZ[ids[i]] - world.positionZ[ids[j]],
          )
          const isAbove = d >= 0.8
          if (above.has(key) && above.get(key) !== isAbove) {
            crossings.set(key, (crossings.get(key) ?? 0) + 1)
          }
          above.set(key, isAbove)
        }
      }
    }
  }
  assert(reachTick > 0 && reachTick <= 45, `P2 deadline: reached 0.8 separation at tick ${reachTick} (bound 45)`)
  for (const [key, n] of crossings) {
    assert(n <= 2, `P2 hold: pair ${key} crossed the threshold ${n} times (bound 2)`)
  }
  let cx = 0
  let cz = 0
  for (const id of ids) {
    cx += world.positionX[id]
    cz += world.positionZ[id]
  }
  const drift = Math.hypot(cx / ids.length - 10, cz / ids.length - 10)
  assert(drift <= 0.1, `P3 centroid drift ${drift.toFixed(4)} (bound 0.1)`)
})

// P4: the coincident direction for a fixed id pair is a literal.
// First two spawns in a bare world are ids 1 and 2; the id-pair slot
// function gives slot 3, whose table entry is (0, +1): the higher id
// moves +z, the lower id −z, each by exactly CAP (share 0.5 capped).
test('P4 coincident direction is pinned for id pair (1, 2)', () => {
  const world = bareWorld()
  const a = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  const b = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  assert(a.id === 1 && b.id === 2, `pin assumes spawn ids 1,2 (got ${a.id},${b.id})`)
  world.update(STEP)
  assertClose(world.positionX[b.id], 0, 1e-6, 'P4 hi id x')
  assertClose(world.positionZ[b.id], SEPARATION_CAP, 1e-6, 'P4 hi id z (+table slot 3)')
  assertClose(world.positionX[a.id], 0, 1e-6, 'P4 lo id x')
  assertClose(world.positionZ[a.id], -SEPARATION_CAP, 1e-6, 'P4 lo id z (−table slot 3)')
  const v = SURROUND_OFFSETS[3]
  assertClose(v[1], 1, 1e-12, 'P4 table slot 3 is the +z literal')
})

// P5: a HOLD unit is never displaced; marchers resolve around it.
test('P5 STATE_HOLD anchor is bit-identical while marchers pass', () => {
  const world = bareWorld()
  const anchor = world.spawnUnit('worker', TEAM_PLAYER, 0, 0)
  orderHold(world, anchor.id)
  const marchers: number[] = []
  for (let i = 0; i < 5; i++) {
    const m = world.spawnUnit('worker', TEAM_PLAYER, -0.3 + i * 0.15, -0.2 + (i % 2) * 0.3)
    marchers.push(m.id)
    orderMove(world, m.id, 20, world.positionZ[m.id])
  }
  const ax = world.positionX[anchor.id]
  const az = world.positionZ[anchor.id]
  step(world, 900)
  assert(world.positionX[anchor.id] === ax && world.positionZ[anchor.id] === az, 'P5 anchor position bit-identical')
  assert(world.state[anchor.id] === STATE_HOLD, 'P5 anchor still holding')
  for (const id of marchers) {
    assert(world.moving[id] === 0 && world.positionX[id] > 15, `P5 marcher ${id} walked past and arrived`)
  }
})

// P6: attackers in reach at pass start are in reach at every strike
// check (anchors), and damage flows every cooldown window.
test('P6 in-reach attackers are never displaced and keep striking', () => {
  const world = bareWorld(true)
  const target = world.spawnUnit('melee', TEAM_ENEMY, 0, 0)
  world.health[target.id] = 100000
  orderHold(world, target.id)
  const attackers: number[] = []
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2
    const a = world.spawnUnit('melee', TEAM_PLAYER, Math.cos(ang) * 2.5, Math.sin(ang) * 2.5)
    attackers.push(a.id)
    orderAttack(world, a.id, target.id)
  }
  const reachOf = (id: number) => world.attackRange[id] + world.radius[target.id]
  let hpPrev = world.health[target.id]
  let windowsWithDamage = 0
  for (let w = 0; w < 10; w++) {
    for (let t = 0; t < 180; t++) {
      for (const id of attackers) {
        const d = Math.hypot(
          world.positionX[id] - world.positionX[target.id],
          world.positionZ[id] - world.positionZ[target.id],
        )
        assert(d <= reachOf(id) + 1e-4, `P6 attacker ${id} out of reach at window ${w} (d=${d.toFixed(3)})`)
      }
      world.update(STEP)
    }
    if (world.health[target.id] < hpPrev) windowsWithDamage += 1
    hpPrev = world.health[target.id]
  }
  assert(windowsWithDamage === 10, `P6 damage flowed in ${windowsWithDamage}/10 windows`)
})

// P8: with no combat in the scene, the pass changes ONLY positions —
// including for relieved units, whose `moving` timeline is steering's
// alone (NP4's field-level form).
test('P8 pass touches no field other than participant positions', () => {
  const build = () => {
    const world = bareWorld()
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push(world.spawnUnit('worker', TEAM_PLAYER, 0, 0).id)
    const movers: number[] = []
    const targets = [[40, -30], [-35, 25], [30, 40]] as const
    for (let i = 0; i < 3; i++) {
      const m = world.spawnUnit('worker', TEAM_PLAYER, -20 + i * 20, -20)
      movers.push(m.id)
      orderMove(world, m.id, targets[i][0], targets[i][1])
    }
    return { world, all: [...ids, ...movers] }
  }
  const on = build()
  step(on.world, 300)
  setSeparationEnabledForTests(false)
  const off = build()
  step(off.world, 300)
  setSeparationEnabledForTests(true)
  const fields = ['moving', 'state', 'targetId', 'stopDist', 'velocityX', 'velocityZ', 'carryAmount', 'gatherTimer'] as const
  for (const id of on.all) {
    for (const f of fields) {
      const arr = on.world[f] as unknown as ArrayLike<number>
      const arrOff = off.world[f] as unknown as ArrayLike<number>
      assert(arr[id] === arrOff[id], `P8 field ${f} of unit ${id} differs (on=${arr[id]}, off=${arrOff[id]})`)
    }
  }
  // And positions DID diverge for the stacked idle units (pass active).
  assert(
    Math.hypot(on.world.positionX[on.all[0]] - off.world.positionX[on.all[0]], on.world.positionZ[on.all[0]] - off.world.positionZ[on.all[0]]) > 0.1,
    'P8 sanity: the stacked units actually separated with the pass on',
  )
})

// P14′ (ring approach): 8 melee ordered onto one held target
// distribute around it — ≥6 bearing slots, every ordered attacker in
// reach (the ring clauses stand unchanged, addendum §A5.2). Pairwise:
// combat stops an attacker where it ENTERS reach (moving = 0 in
// reach) and §3 then makes it an anchor — a pair whose entry points
// land closer than 0.8 × contact is frozen by anchor integrity (P5)
// and cannot be resolved by the pass under ANY receiving rule. The
// §5(ii)/P14′ allowance covers exactly this: sub-0.8 pairs are
// counted, each must be anchored-first (one member in reach before
// the other entered), and > 2 fails. (The addendum writes the
// allowance against the LINE approach; the ring approach exhibits the
// same mechanism — counted and reported either way.)
test('P14 surround ring distributes 8 attackers over >= 6 bearings', () => {
  const world = bareWorld(true)
  const target = world.spawnUnit('melee', TEAM_ENEMY, 0, 0)
  world.health[target.id] = 100000
  world.damage[target.id] = 0
  world.moveSpeed[target.id] = 0
  orderHold(world, target.id)
  const attackers: number[] = []
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4
    const a = world.spawnUnit('melee', TEAM_PLAYER, Math.cos(ang) * 15, Math.sin(ang) * 15)
    attackers.push(a.id)
    orderAttack(world, a.id, target.id)
  }
  const reach0 = world.attackRange[attackers[0]] + world.radius[target.id]
  const entryTick = new Map<number, number>()
  for (let t = 0; t < 1500; t++) {
    world.update(STEP)
    for (const id of attackers) {
      const d = Math.hypot(world.positionX[id] - world.positionX[target.id], world.positionZ[id] - world.positionZ[target.id])
      if (!entryTick.has(id) && d <= reach0) entryTick.set(id, t + 1)
    }
  }
  const tx = world.positionX[target.id]
  const tz = world.positionZ[target.id]
  const reach = world.attackRange[attackers[0]] + world.radius[target.id]
  const inReach = attackers.filter((id) => {
    const d = Math.hypot(world.positionX[id] - tx, world.positionZ[id] - tz)
    return world.entities.has(id) && d <= reach + 1e-4
  })
  assert(inReach.length === 8, `P14 every ordered attacker in reach (${inReach.length}/8)`)
  const sectors = new Set<number>()
  for (const id of inReach) {
    const dx = world.positionX[id] - tx
    const dz = world.positionZ[id] - tz
    const len = Math.hypot(dx, dz)
    const nx = dx / len
    const nz = dz / len
    let best = 0
    let bestDot = -Infinity
    for (let s = 0; s < SURROUND_OFFSETS.length; s++) {
      const dot = nx * SURROUND_OFFSETS[s][0] + nz * SURROUND_OFFSETS[s][1]
      if (dot > bestDot) {
        bestDot = dot
        best = s
      }
    }
    sectors.add(best)
  }
  assert(sectors.size >= 6, `P14 distinct bearing sectors ${sectors.size} (bound 6)`)
  // §5(ii) allowance census: sub-0.8 pairs among in-reach attackers.
  let allowancePairs = 0
  for (let i = 0; i < inReach.length; i++) {
    for (let j = i + 1; j < inReach.length; j++) {
      const a = inReach[i]
      const b = inReach[j]
      const d = Math.hypot(world.positionX[a] - world.positionX[b], world.positionZ[a] - world.positionZ[b])
      if (d < 0.8) {
        allowancePairs += 1
        const ea = entryTick.get(a) ?? Infinity
        const eb = entryTick.get(b) ?? Infinity
        assert(
          ea !== eb,
          `P14′ pair ${a}/${b} at ${d.toFixed(3)} is sub-0.8 without an anchored-first entry order (${ea}/${eb})`,
        )
      }
    }
  }
  assert(allowancePairs <= 2, `P14′ sub-0.8 allowance pairs ${allowancePairs} (bound 2)`)
})

// C3: the same ring against a building target, which dies under them.
test('C3 squad rings an enemy hall and kills it', () => {
  const world = bareWorld(true)
  const hall = world.spawnBuilding('hall', TEAM_ENEMY, 0, 0, true)
  world.health[hall.id] = 900
  const attackers: number[] = []
  for (let i = 0; i < 8; i++) {
    const a = world.spawnUnit('melee', TEAM_PLAYER, -25 + i * 0.5, -25)
    attackers.push(a.id)
    orderAttack(world, a.id, hall.id)
  }
  let diedAt = -1
  for (let t = 0; t < 3600; t++) {
    world.update(STEP)
    if (!world.entities.has(hall.id)) {
      diedAt = t + 1
      break
    }
  }
  assert(diedAt > 0, 'C3 hall died under the squad')
})

// C5: a stack in the map corner resolves inside the field, no NaN.
test('C5 corner stack stays in the field and separates', () => {
  const world = bareWorld()
  const ids: number[] = []
  for (let i = 0; i < 6; i++) ids.push(world.spawnUnit('worker', TEAM_PLAYER, 89, 89).id)
  step(world, 600)
  for (const id of ids) {
    const x = world.positionX[id]
    const z = world.positionZ[id]
    assert(Number.isFinite(x) && Number.isFinite(z), `C5 unit ${id} finite`)
    assert(Math.abs(x) <= 90 && Math.abs(z) <= 90, `C5 unit ${id} inside field (${x.toFixed(2)},${z.toFixed(2)})`)
  }
  const d = minPairwise(world, ids)
  assert(d >= 0.7, `C5 corner min pairwise ${d.toFixed(3)} (clamped bound 0.7)`)
})

// C8: coincident in-reach attackers from a save keep striking.
test('C8 coincident in-reach attackers keep striking (tolerated overlap)', () => {
  const world = bareWorld(true)
  const target = world.spawnUnit('melee', TEAM_ENEMY, 0, 0)
  world.health[target.id] = 100000
  orderHold(world, target.id)
  const a1 = world.spawnUnit('melee', TEAM_PLAYER, 2.0, 0)
  const a2 = world.spawnUnit('melee', TEAM_PLAYER, 2.0, 0)
  orderAttack(world, a1.id, target.id)
  orderAttack(world, a2.id, target.id)
  const hp0 = world.health[target.id]
  step(world, 600)
  const dealt = hp0 - world.health[target.id]
  // One attacker alone lands ~10 strikes x 18 = ~180 in 10 s; two must
  // clearly exceed a single attacker's output.
  assert(dealt >= 270, `C8 both strikers dealing damage (dealt ${dealt} in 10 s)`)
  assert(world.state[a1.id] === STATE_ATTACK && world.state[a2.id] === STATE_ATTACK, 'C8 both still in STATE_ATTACK')
})

// C7: a spawn clump at a door spreads while an enemy passes.
test('C7 spawn clump spreads under fire and engages', () => {
  const world = bareWorld(true)
  const squad: number[] = []
  for (let i = 0; i < 4; i++) squad.push(world.spawnUnit('melee', TEAM_PLAYER, 0, 0).id)
  const foe = world.spawnUnit('melee', TEAM_ENEMY, 14, 0)
  world.health[foe.id] = 100000
  orderMove(world, foe.id, -14, 0)
  let spreadTick = -1
  for (let t = 0; t < 900; t++) {
    world.update(STEP)
    if (spreadTick < 0 && minPairwise(world, squad) >= 0.8) spreadTick = t + 1
  }
  assert(spreadTick > 0 && spreadTick <= 120, `C7 clump spread by tick ${spreadTick}`)
  assert(world.health[foe.id] < 100000, 'C7 the squad acquired and damaged the passer-by')
})

// ---------------------------------------------------------------------------
// The amended-design pins (addendum §A2/A3/A5). The two [CONFLICT]
// tests of the first implementation are replaced by AC1 and P2′ below
// — same scenes, amended assertions.
// ---------------------------------------------------------------------------

/** Crossing-scene runner shared by the P7′ arms: two 15-melee columns
 * exchanging places through one centre point; returns per-unit
 * arrival ticks and scans. */
function runCrossing(cap: number): { ratio: number; arrived: number } {
  setSeparationCapForTests(cap)
  try {
    const soloWorld = bareWorld()
    const solo = soloWorld.spawnUnit('melee', TEAM_PLAYER, -40, 0)
    orderMove(soloWorld, solo.id, 40, 0)
    let soloTicks = 0
    for (; soloTicks < 7200; soloTicks++) {
      soloWorld.update(STEP)
      if (soloWorld.moving[solo.id] === 0) {
        soloTicks += 1
        break
      }
    }
    const world = bareWorld()
    const ids: number[] = []
    const scans: ParkScan[] = []
    for (let i = 0; i < 15; i++) {
      const a = world.spawnUnit('melee', TEAM_PLAYER, -40 - Math.floor(i / 5) * 1.5, (i % 5) * 1.2 - 2.4)
      const b = world.spawnUnit('melee', TEAM_ENEMY, 40 + Math.floor(i / 5) * 1.5, (i % 5) * 1.2 - 2.4)
      ids.push(a.id, b.id)
      orderMove(world, a.id, 40, world.positionZ[a.id])
      orderMove(world, b.id, -40, world.positionZ[b.id])
    }
    for (const id of ids) {
      const s = new ParkScan(world.moveSpeed[id])
      s.record(world, id, world.targetX[id], world.targetZ[id])
      scans.push(s)
    }
    const arrivals = new Map<number, number>()
    for (let t = 0; t < 7200; t++) {
      world.update(STEP)
      for (let k = 0; k < ids.length; k++) {
        scans[k].record(world, ids[k], world.targetX[ids[k]], world.targetZ[ids[k]])
        if (!arrivals.has(ids[k]) && world.moving[ids[k]] === 0) arrivals.set(ids[k], t + 1)
      }
      if (arrivals.size === ids.length) break
    }
    let parks = 0
    for (const s of scans) parks += s.count()
    assert(parks === 0, `P7′/NP1 crossing at CAP ${cap}: ${parks} park signatures`)
    let worst = 0
    for (const [, at] of arrivals) worst = Math.max(worst, at)
    return { ratio: worst / soloTicks, arrived: arrivals.size }
  } finally {
    setSeparationCapForTests(null)
  }
}

// P7′: head-on columns arrive within 1.5× solo at CAP, CAP÷2 AND
// 2×CAP (the addendum's three-scaling robustness band). Run 1's
// single-CAP form of this test measured worst ratio 1.04 at CAP 0.06.
test('P7\' head-on columns arrive within 1.5x solo at all three CAP scalings', () => {
  for (const cap of [SEPARATION_CAP / 2, SEPARATION_CAP, SEPARATION_CAP * 2]) {
    const { ratio, arrived } = runCrossing(cap)
    assert(arrived === 30, `P7′ CAP ${cap}: all 30 units arrived (${arrived})`)
    assert(ratio <= 1.5, `P7′ CAP ${cap}: worst arrival ratio ${ratio.toFixed(3)} vs solo (bound 1.5)`)
  }
})

/** The run-1 trace scene, staged exactly: N workers at radius 20
 * around (30, 30), all ordered to (30, 30). Returns arrivals, park
 * counts and the post-arrival separation deadline check. */
function runConvergeTrace(n: number, cap: number): {
  arrived: number
  parks: number
  lastArrival: number
  spreadByDeadline: boolean
  finalSep: number
} {
  setSeparationCapForTests(cap)
  try {
    const soloWorld = bareWorld()
    const solo = soloWorld.spawnUnit('worker', TEAM_PLAYER, 10, 30)
    orderMove(soloWorld, solo.id, 30, 30)
    let soloTicks = 0
    for (; soloTicks < 3600; soloTicks++) {
      soloWorld.update(STEP)
      if (soloWorld.moving[solo.id] === 0) {
        soloTicks += 1
        break
      }
    }
    const world = bareWorld()
    const ids: number[] = []
    const scans: ParkScan[] = []
    for (let i = 0; i < n; i++) {
      const ang = (i * 2 * Math.PI) / n
      const w = world.spawnUnit(
        'worker',
        TEAM_PLAYER,
        30 + Math.cos(ang) * 20,
        30 + Math.sin(ang) * 20,
      )
      ids.push(w.id)
      orderMove(world, w.id, 30, 30)
    }
    for (const id of ids) {
      const s = new ParkScan(world.moveSpeed[id])
      s.record(world, id, 30, 30)
      scans.push(s)
    }
    const arrivals = new Map<number, number>()
    let spreadByDeadline = false
    for (let t = 0; t < 3600; t++) {
      world.update(STEP)
      for (let k = 0; k < ids.length; k++) {
        scans[k].record(world, ids[k], 30, 30)
        if (!arrivals.has(ids[k]) && world.moving[ids[k]] === 0) arrivals.set(ids[k], t + 1)
      }
      if (arrivals.size === ids.length) {
        const last = Math.max(...arrivals.values())
        if (t + 1 === last + 45) spreadByDeadline = minPairwise(world, ids) >= 0.8
      }
    }
    let parks = 0
    for (const s of scans) parks += s.count()
    const lastArrival = arrivals.size ? Math.max(...arrivals.values()) : Infinity
    // P2′: convergence deadline — every unit home within 1.5× solo.
    assert(
      lastArrival <= 1.5 * soloTicks,
      `AC1/P2′ last arrival ${lastArrival} vs 1.5× solo ${Math.floor(1.5 * soloTicks)}`,
    )
    return { arrived: arrivals.size, parks, lastArrival, spreadByDeadline, finalSep: minPairwise(world, ids) }
  } finally {
    setSeparationCapForTests(null)
  }
}

// AC1 (canonical, addendum §A4): the run-1 hex-ring trace. Under the
// first implementation this scene parked all 6 workers at dist 0.545
// forever (the [CONFLICT] pin above). Under the amended receiving
// rules every worker arrives, no park signature exists, at CAP,
// CAP÷2 and 2×CAP.
test('AC1 six workers to one point arrive with zero park signatures (all CAP scalings)', () => {
  for (const cap of [SEPARATION_CAP / 2, SEPARATION_CAP, SEPARATION_CAP * 2]) {
    const r = runConvergeTrace(6, cap)
    assert(r.arrived === 6, `AC1 CAP ${cap}: ${r.arrived}/6 arrived`)
    assert(r.parks === 0, `AC1 CAP ${cap}: ${r.parks} park signatures (bound 0)`)
    assert(r.spreadByDeadline, `AC1 CAP ${cap}: P1′ separation ≥ 0.8 within 45 ticks of last arrival`)
    assert(r.finalSep >= 0.8, `AC1 CAP ${cap}: final separation ${r.finalSep.toFixed(3)} (bound 0.8)`)
  }
})

test('AC1 two workers to one point arrive with zero park signatures', () => {
  const r = runConvergeTrace(2, SEPARATION_CAP)
  assert(r.arrived === 2, `AC1-2: ${r.arrived}/2 arrived`)
  assert(r.parks === 0, `AC1-2: ${r.parks} park signatures (bound 0)`)
  assert(r.spreadByDeadline, 'AC1-2: separated within 45 ticks of last arrival')
})

// P2′ (the F1 [CONFLICT] pin, re-stated): five workers from spread
// starts ordered to the origin — arrive stacked, then spread.
test('P2\' five workers ordered to one point arrive, then spread', () => {
  const world = bareWorld()
  const soloWorld = bareWorld()
  const solo = soloWorld.spawnUnit('worker', TEAM_PLAYER, -15, -15)
  orderMove(soloWorld, solo.id, 0, 0)
  let soloTicks = 0
  for (; soloTicks < 3600; soloTicks++) {
    soloWorld.update(STEP)
    if (soloWorld.moving[solo.id] === 0) {
      soloTicks += 1
      break
    }
  }
  const starts = [[-15, -15], [-8, -15], [-1, -15], [6, -15], [13, -15]] as const
  const ids: number[] = []
  const scans: ParkScan[] = []
  for (const [x, z] of starts) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, x, z)
    ids.push(w.id)
    orderMove(world, w.id, 0, 0)
  }
  for (const id of ids) {
    const s = new ParkScan(world.moveSpeed[id])
    s.record(world, id, 0, 0)
    scans.push(s)
  }
  const arrivals = new Map<number, number>()
  let spreadByDeadline = false
  for (let t = 0; t < 1800; t++) {
    world.update(STEP)
    for (let k = 0; k < ids.length; k++) {
      scans[k].record(world, ids[k], 0, 0)
      if (!arrivals.has(ids[k]) && world.moving[ids[k]] === 0) arrivals.set(ids[k], t + 1)
    }
    if (arrivals.size === ids.length && t + 1 === Math.max(...arrivals.values()) + 45) {
      spreadByDeadline = minPairwise(world, ids) >= 0.8
    }
  }
  let parks = 0
  for (const s of scans) parks += s.count()
  assert(arrivals.size === 5, `P2′ ${arrivals.size}/5 arrived (run 1: 0/5, parked)`)
  assert(parks === 0, `P2′ ${parks} park signatures (bound 0)`)
  const last = Math.max(...arrivals.values())
  assert(last <= 1.5 * soloTicks, `P2′ last arrival ${last} vs 1.5× solo ${Math.floor(1.5 * soloTicks)}`)
  assert(spreadByDeadline, 'P2′ min pairwise ≥ 0.8 within 45 ticks of last arrival')
  const d = minPairwise(world, ids)
  assert(d >= 0.8, `P2′ final min pairwise ${d.toFixed(3)} (bound 0.8)`)
})

// AC2 (addendum §A4): equilibrium fuzz. Groups of 4–12 mixed units
// with shared destinations from mixed sources, several densities,
// 10,000 ticks, all three CAP scalings: zero park signatures, and
// every unit home (plain move orders always terminate).
test('AC2 equilibrium fuzz: shared destinations, mixed sources, zero parks', () => {
  const caps = [SEPARATION_CAP / 2, SEPARATION_CAP, SEPARATION_CAP * 2]
  for (let sceneIdx = 0; sceneIdx < 3; sceneIdx++) {
    for (const cap of caps) {
      setSeparationCapForTests(cap)
      try {
        const rand = lcg(1000 + sceneIdx * 77 + Math.round(cap * 10000))
        const world = bareWorld()
        const tracked: { id: number; scan: ParkScan; dx: number; dz: number }[] = []
        const kinds = ['worker', 'melee', 'ranged'] as const
        if (sceneIdx === 0) {
          // Converging groups from mixed bearings onto shared points.
          const dests = [[-30, -30], [30, 10], [0, 40]] as const
          for (const [dx, dz] of dests) {
            const n = 4 + Math.floor(rand() * 9)
            for (let i = 0; i < n; i++) {
              const ang = rand() * 2 * Math.PI
              const r = 15 + rand() * 10
              const u = world.spawnUnit(kinds[Math.floor(rand() * 3)], TEAM_PLAYER, dx + Math.cos(ang) * r, dz + Math.sin(ang) * r)
              orderMove(world, u.id, dx, dz)
              tracked.push({ id: u.id, scan: new ParkScan(world.moveSpeed[u.id]), dx, dz })
            }
          }
        } else if (sceneIdx === 1) {
          // Spawn-door rally: a coincident stack ordered out together.
          const n = 10
          for (let i = 0; i < n; i++) {
            const u = world.spawnUnit(kinds[i % 3], TEAM_PLAYER, 0, 0)
            orderMove(world, u.id, 25, -10)
            tracked.push({ id: u.id, scan: new ParkScan(world.moveSpeed[u.id]), dx: 25, dz: -10 })
          }
        } else {
          // Counter-rally: two coincident clusters exchange rally points.
          for (let i = 0; i < 8; i++) {
            const a = world.spawnUnit(kinds[i % 3], TEAM_PLAYER, -35, 0)
            orderMove(world, a.id, 35, 0)
            tracked.push({ id: a.id, scan: new ParkScan(world.moveSpeed[a.id]), dx: 35, dz: 0 })
            const b = world.spawnUnit(kinds[(i + 1) % 3], TEAM_ENEMY, 35, 0)
            orderMove(world, b.id, -35, 0)
            tracked.push({ id: b.id, scan: new ParkScan(world.moveSpeed[b.id]), dx: -35, dz: 0 })
          }
        }
        for (const tr of tracked) tr.scan.record(world, tr.id, tr.dx, tr.dz)
        for (let t = 0; t < 10000; t++) {
          world.update(STEP)
          for (const tr of tracked) tr.scan.record(world, tr.id, tr.dx, tr.dz)
        }
        let parks = 0
        let home = 0
        for (const tr of tracked) {
          parks += tr.scan.count()
          if (world.moving[tr.id] === 0) home += 1
        }
        assert(parks === 0, `AC2 scene ${sceneIdx} CAP ${cap}: ${parks} park signatures (bound 0)`)
        assert(home === tracked.length, `AC2 scene ${sceneIdx} CAP ${cap}: ${home}/${tracked.length} units home after 10,000 ticks`)
      } finally {
        setSeparationCapForTests(null)
      }
    }
  }
})

// AC3 + NP3: a single mover crosses a dense static crowd to a point
// at its far edge. NP3: its distance to destination never increases
// by more than 0.01 on any tick; P2′: arrival ≤ 1.5× solo.
test('AC3/NP3 mover through a dense crowd: monotone approach, bounded delay', () => {
  const soloWorld = bareWorld()
  const solo = soloWorld.spawnUnit('worker', TEAM_PLAYER, -20, 0)
  orderMove(soloWorld, solo.id, 1.8, 0)
  let soloTicks = 0
  for (; soloTicks < 3600; soloTicks++) {
    soloWorld.update(STEP)
    if (soloWorld.moving[solo.id] === 0) {
      soloTicks += 1
      break
    }
  }
  const world = bareWorld()
  const crowd: number[] = []
  for (let i = 0; i < 8; i++) {
    const ang = (i * 2 * Math.PI) / 8
    crowd.push(world.spawnUnit('worker', TEAM_PLAYER, Math.cos(ang) * 1.2, Math.sin(ang) * 1.2).id)
  }
  const mover = world.spawnUnit('worker', TEAM_PLAYER, -20, 0)
  step(world, 100) // crowd settles at rest before the mover is ordered
  orderMove(world, mover.id, 1.8, 0)
  let prevDist = Math.hypot(world.positionX[mover.id] - 1.8, world.positionZ[mover.id])
  let arrival = -1
  let worstIncrease = 0
  for (let t = 0; t < 3600; t++) {
    world.update(STEP)
    const d = Math.hypot(world.positionX[mover.id] - 1.8, world.positionZ[mover.id])
    if (world.moving[mover.id] === 1) worstIncrease = Math.max(worstIncrease, d - prevDist)
    prevDist = d
    if (world.moving[mover.id] === 0) {
      arrival = t + 1
      break
    }
  }
  assert(arrival > 0, 'AC3 mover arrived')
  assert(arrival <= 1.5 * soloTicks, `AC3 arrival ${arrival} vs 1.5× solo ${Math.floor(1.5 * soloTicks)}`)
  assert(worstIncrease <= 0.01, `NP3 worst per-tick distance increase ${worstIncrease.toFixed(5)} (bound 0.01)`)
})

// AC5 + NP4: destination just inside a crowd, approached from four
// bearings. Monotone approach (NP3 bound), exactly one relief-band
// entry per approach (no boundary flicker), arrival every time.
test('AC5 band-edge approach from four bearings: single band entry, arrival', () => {
  const bandOf = (world: World, id: number) =>
    world.stopDist[id] + Math.max(2 * world.radius[id], 1.0)
  const bearings = [[12.8, 0], [-11.2, 0], [0.8, 12], [0.8, -12]] as const
  for (const [sx, sz] of bearings) {
    const soloWorld = bareWorld()
    const solo = soloWorld.spawnUnit('worker', TEAM_PLAYER, sx, sz)
    orderMove(soloWorld, solo.id, 0.8, 0)
    let soloTicks = 0
    for (; soloTicks < 3600; soloTicks++) {
      soloWorld.update(STEP)
      if (soloWorld.moving[solo.id] === 0) {
        soloTicks += 1
        break
      }
    }
    const world = bareWorld()
    for (let i = 0; i < 8; i++) {
      const ang = (i * 2 * Math.PI) / 8
      world.spawnUnit('worker', TEAM_PLAYER, Math.cos(ang) * 1.2, Math.sin(ang) * 1.2)
    }
    const mover = world.spawnUnit('worker', TEAM_PLAYER, sx, sz)
    step(world, 100)
    orderMove(world, mover.id, 0.8, 0)
    const band = bandOf(world, mover.id)
    let inBand = Math.hypot(world.positionX[mover.id] - 0.8, world.positionZ[mover.id]) <= band
    let entries = inBand ? 1 : 0
    let prevDist = Math.hypot(world.positionX[mover.id] - 0.8, world.positionZ[mover.id])
    let worstIncrease = 0
    let arrival = -1
    for (let t = 0; t < 3600; t++) {
      world.update(STEP)
      const d = Math.hypot(world.positionX[mover.id] - 0.8, world.positionZ[mover.id])
      if (world.moving[mover.id] === 1) {
        worstIncrease = Math.max(worstIncrease, d - prevDist)
        const nowIn = d <= band
        if (nowIn && !inBand) entries += 1
        inBand = nowIn
      }
      prevDist = d
      if (world.moving[mover.id] === 0) {
        arrival = t + 1
        break
      }
    }
    assert(arrival > 0, `AC5 bearing (${sx},${sz}): arrived`)
    assert(arrival <= 1.5 * soloTicks, `AC5 bearing (${sx},${sz}): arrival ${arrival} vs 1.5× solo ${Math.floor(1.5 * soloTicks)}`)
    assert(entries === 1, `AC5 bearing (${sx},${sz}): ${entries} band entries (bound 1, NP4)`)
    assert(worstIncrease <= 0.01, `AC5 bearing (${sx},${sz}): worst distance increase ${worstIncrease.toFixed(5)} (bound 0.01, NP3)`)
  }
})

// NP2 + NP4 (relief integrity): a worker cycling at a node, with an
// idle pair stacked at the hall doorstep INSIDE the worker's relief
// band (5.5 from the hall centre; the band reaches stopDist ≈ 6.0 +
// 1.0 = 7.0, and the pair can spread to at most 6.0 from the centre,
// so every contact the returning worker can have with them happens
// while it is relieved). The worker's whole trajectory until its
// deposit must be bit-identical pass-on vs pass-off (its doorstep
// motion is baseline), the deposit lands on the same tick — and the
// idle pair DOES separate with the pass on (the pass is demonstrably
// active in the same world; with it off they stay coincident).
test('NP2/NP4 relieved worker trajectory is bit-identical to pass-off until deposit', () => {
  const build = () => {
    const world = gatherWorld()
    world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
    world.gold[TEAM_PLAYER] = 0
    const node = world.spawnResource('gold', 12, 0)
    const ringX = 12 - (world.radius[node.id] + 0.8)
    const w = world.spawnUnit('worker', TEAM_PLAYER, ringX, 0)
    world.harvestKind[w.id] = HARVEST_GOLD
    const pair: number[] = []
    for (let i = 0; i < 2; i++) {
      const p = world.spawnUnit('worker', TEAM_PLAYER, 5.5, 0)
      world.harvestKind[p.id] = HARVEST_OFF
      pair.push(p.id)
    }
    return { world, worker: w.id, pair }
  }
  const run = (passOn: boolean, extraTicks: number) => {
    setSeparationEnabledForTests(passOn)
    const { world, worker, pair } = build()
    const traj: { x: number; z: number; m: number }[] = []
    let depositTick = -1
    for (let t = 0; t < 3600; t++) {
      world.update(STEP)
      traj.push({ x: world.positionX[worker], z: world.positionZ[worker], m: world.moving[worker] })
      if (world.gold[TEAM_PLAYER] > 0) {
        depositTick = t + 1
        break
      }
    }
    for (let t = 0; t < extraTicks; t++) world.update(STEP)
    const pairEnd = pair.map((id) => ({ x: world.positionX[id], z: world.positionZ[id] }))
    setSeparationEnabledForTests(true)
    return { world, worker, pair, traj, depositTick, pairEnd }
  }
  const on = run(true, 60)
  const off = run(false, 0)
  assert(on.depositTick > 0, `NP2 worker deposited (tick ${on.depositTick})`)
  assert(on.depositTick === off.depositTick, `NP2 deposit tick on=${on.depositTick} off=${off.depositTick}`)
  assert(on.traj.length === off.traj.length, 'NP2 trajectory lengths equal')
  // Identity is asserted through the ARRIVAL record (the tick steering
  // set moving = 0, one tick before the deposit is processed). On the
  // deposit tick itself the worker is STATE_IDLE — its business with
  // the destination has ended, relief has ended with it (§A2.3), and
  // it may lawfully be displaced as an ordinary participant.
  for (let t = 0; t < on.traj.length - 1; t++) {
    const a = on.traj[t]
    const b = off.traj[t]
    assert(
      a.x === b.x && a.z === b.z && a.m === b.m,
      `NP2 tick ${t + 1}: relieved trajectory diverged (on ${a.x},${a.z},m${a.m} vs off ${b.x},${b.z},m${b.m})`,
    )
  }
  // Pass-active sanity: in the ON run the idle pair at the doorstep
  // separated; in the OFF run they are still coincident at spawn.
  const onPairDist = Math.hypot(on.pairEnd[0].x - on.pairEnd[1].x, on.pairEnd[0].z - on.pairEnd[1].z)
  const offPairDist = Math.hypot(off.pairEnd[0].x - off.pairEnd[1].x, off.pairEnd[0].z - off.pairEnd[1].z)
  assert(onPairDist >= 0.8, `NP2 sanity: idle pair separated with pass on (${onPairDist.toFixed(3)})`)
  assert(offPairDist === 0, `NP2 sanity: idle pair coincident with pass off (${offPairDist})`)
})

// AC4 (relief boundary at a node, addendum §A4 as amended): two
// workers cycling at a mine keep harvesting (relief preserves cycle
// geometry — deposits land), while two IDLE workers coincident at the
// same node are NOT relieved (relief is state semantics, not
// position): they separate under P2′.
test('AC4 cycling workers keep banking; idle workers at the same node separate', () => {
  const world = gatherWorld()
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)
  world.gold[TEAM_PLAYER] = 0
  const node = world.spawnResource('gold', 12, 0)
  const ringX = 12 - (world.radius[node.id] + 0.8)
  const cyclers: number[] = []
  const cycSpots = [[4, 4], [4, 6]] as const
  for (const [x, z] of cycSpots) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, x, z)
    world.harvestKind[w.id] = HARVEST_GOLD
    cyclers.push(w.id)
  }
  const idle: number[] = []
  for (let i = 0; i < 2; i++) {
    const w = world.spawnUnit('worker', TEAM_PLAYER, ringX, 0)
    world.harvestKind[w.id] = HARVEST_OFF
    idle.push(w.id)
  }
  let idleSepTick = -1
  for (let t = 0; t < 2400; t++) {
    world.update(STEP)
    if (idleSepTick < 0 && minPairwise(world, idle) >= 0.8) idleSepTick = t + 1
  }
  assert(idleSepTick > 0 && idleSepTick <= 45, `AC4 idle pair separated by tick ${idleSepTick} (P2′ deadline 45)`)
  assert(world.state[idle[0]] === STATE_IDLE && world.state[idle[1]] === STATE_IDLE, 'AC4 idle pair stayed idle')
  assert(world.gold[TEAM_PLAYER] > 0, `AC4 cyclers banked gold (${world.gold[TEAM_PLAYER]})`)
  for (const id of cyclers) {
    assert(
      world.state[id] === STATE_GATHER || world.carryAmount[id] >= 0,
      `AC4 cycler ${id} still on the economy (state ${world.state[id]})`,
    )
  }
})

// AC8 (addendum §A4): a short-reach squad chases a fleeing target
// THROUGH a friendly crowd. The ring must form at the kill (sectors +
// in-reach stand), the §5(ii) allowance census applies at the kill,
// and no chaser may park (a chaser's distance to its target trends to
// reach — the moving-destination form of the park check: every chaser
// is in reach at the kill or striking).
test('AC8 squad chases a fleeing target through a friendly crowd and rings the kill', () => {
  const world = bareWorld(true)
  // Friendly crowd settled across the chase path.
  const crowd: number[] = []
  for (let i = 0; i < 6; i++) {
    const ang = (i * 2 * Math.PI) / 6
    crowd.push(world.spawnUnit('worker', TEAM_PLAYER, 2 + Math.cos(ang) * 1.1, Math.sin(ang) * 1.1).id)
  }
  const target = world.spawnUnit('worker', TEAM_ENEMY, 10, 0)
  world.moveSpeed[target.id] = 2.5 // a straggler the squad can run down
  orderMove(world, target.id, 60, 0)
  const chasers: number[] = []
  for (let i = 0; i < 4; i++) {
    const c = world.spawnUnit('melee', TEAM_PLAYER, -10, -3 + i * 2)
    chasers.push(c.id)
    orderAttack(world, c.id, target.id)
  }
  step(world, 60) // crowd settles before the squad reaches it
  const reach = world.attackRange[chasers[0]] + world.radius[target.id]
  const entryTick = new Map<number, number>()
  let killTick = -1
  for (let t = 0; t < 2400; t++) {
    world.update(STEP)
    for (const id of chasers) {
      if (!world.entities.has(target.id)) break
      const d = Math.hypot(world.positionX[id] - world.positionX[target.id], world.positionZ[id] - world.positionZ[target.id])
      if (!entryTick.has(id) && d <= reach) entryTick.set(id, t + 1)
    }
    if (!world.entities.has(target.id)) {
      killTick = t + 1
      break
    }
  }
  assert(killTick > 0, 'AC8 the squad ran the straggler down through the crowd')
  // At the kill: every chaser in reach or having entered reach (the
  // striker set), over >= 3 bearing sectors.
  const tx = world.positionX[target.id]
  const tz = world.positionZ[target.id]
  const inReach = chasers.filter((id) => entryTick.has(id))
  assert(inReach.length >= 3, `AC8 chasers reached the target (${inReach.length}/4 entered reach)`)
  const sectors = new Set<number>()
  for (const id of inReach) {
    const dx = world.positionX[id] - tx
    const dz = world.positionZ[id] - tz
    const len = Math.hypot(dx, dz) || 1
    let best = 0
    let bestDot = -Infinity
    for (let s = 0; s < SURROUND_OFFSETS.length; s++) {
      const dot = (dx / len) * SURROUND_OFFSETS[s][0] + (dz / len) * SURROUND_OFFSETS[s][1]
      if (dot > bestDot) {
        bestDot = dot
        best = s
      }
    }
    sectors.add(best)
  }
  assert(sectors.size >= 3, `AC8 kill formed over ${sectors.size} bearing sectors (bound 3)`)
  let allowancePairs = 0
  for (let i = 0; i < inReach.length; i++) {
    for (let j = i + 1; j < inReach.length; j++) {
      const a = inReach[i]
      const b = inReach[j]
      const d = Math.hypot(world.positionX[a] - world.positionX[b], world.positionZ[a] - world.positionZ[b])
      if (d < 0.8) {
        allowancePairs += 1
        const ea = entryTick.get(a) ?? Infinity
        const eb = entryTick.get(b) ?? Infinity
        assert(ea !== eb, `AC8 pair ${a}/${b} sub-0.8 without anchored-first entries (${ea}/${eb})`)
      }
    }
  }
  assert(allowancePairs <= 2, `AC8 sub-0.8 allowance pairs at the kill: ${allowancePairs} (bound 2)`)
  for (const id of crowd) {
    assert(world.entities.has(id) && world.health[id] > 0, 'AC8 the friendly crowd is unharmed')
  }
})
