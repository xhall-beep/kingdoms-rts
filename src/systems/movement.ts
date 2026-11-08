import type { System, World } from '../core/World'
import { KIND_TREE } from '../core/World'
import { SpatialHash } from '../core/spatial-hash.ts'
import { FACTIONS } from '../data/factions.ts'
import { rallySpeedMult } from './warhorn.ts'
import { seasonSpeedMult } from './season.ts'
import { HARVEST_OFF, KIND_WORKER, KIND_MELEE, KIND_RANGED, KIND_TREANT, NO_TARGET, STATE_IDLE, STATE_MOVE , STATE_PATROL, STATE_HOLD, STATE_GATHER, STATE_RETURN, STATE_BUILD, STATE_MUSTER, STATE_DISARM} from '../core/World'
import { SURROUND_OFFSETS } from '../core/Math.ts'

/**
 * Steering: every entity flagged `moving` walks toward (targetX, targetZ) at
 * moveSpeed and stops within stopDist. Never overshoots the arrival radius.
 * Writes the velocity arrays so the Engine's interpolation keeps working.
 */
/**
 * Elf signature: woodland speed bonus when near trees.
 * Deterministic: spatial hash in world order; first tree found wins.
 */
function getEffectiveSpeed(world: World, id: number, hash: SpatialHash): number {
  const base = world.moveSpeed[id]
  // Neutral creatures (treants) belong to no faction: no rally, no
  // woodland blessing — only the season's snow slows them.
  if (world.team[id] > 1) return base * seasonSpeedMult(world)
  const team = world.team[id] as 0 | 1
  // War Horn: Gale March quickens the army's stride.
  const rally = rallySpeedMult(world, team)
  // Season Wheel: snow slows every stride once winter turns.
  const pace = rally * seasonSpeedMult(world)
  const woodland = FACTIONS[world.factionOfTeam[team]].signature?.woodland
  if (!woodland) return base * pace

  // Check if near any tree (cell 24 > treeRadius 8, so 3x3 covers it)
  const px = world.positionX[id]
  const pz = world.positionZ[id]
  const r2 = woodland.treeRadius * woodland.treeRadius
  let nearTree = false
  hash.forEachNear(px, pz, (tid) => {
    if (nearTree) return
    if (world.kind[tid] !== KIND_TREE) return
    const dx = world.positionX[tid] - px
    const dz = world.positionZ[tid] - pz
    if (dx * dx + dz * dz <= r2) nearTree = true
  })
  return (nearTree ? base * (1 + woodland.speedBonus) : base) * pace
}

/**
 * Unit separation (audit item #2; design note
 * anchor-separation-2026-11-07.md AS AMENDED by
 * anchor-separation-addendum-2026-11-07.md — the convergence
 * settlement). A deterministic push-apart pass for overlapping mobile
 * units, run inside the movement tick AFTER steering integration —
 * movement is the only system allowed to change positions and it runs
 * last, so the pass lives here, never as its own system. It writes
 * only positionX/positionZ of participants: every arrival, harvest
 * and deposit decision in the game keys on flags, not distance.
 *
 * RECEIVING RULES (addendum §A2 — the first implementation's
 * positional-push-for-everyone rule is superseded): steering's
 * terminal step min(speed·dt, dist − stopDist) decays continuously to
 * zero at the stop ring, so ANY sustained received radial force parks
 * a converging group at stopDist + p — a stable equilibrium at every
 * CAP (measured by the first implementation: a hexagonal ring at
 * dist 0.545 vs stopDist 0.5, bit-identical for 3,600 ticks, AI
 * economies starved). The amended pass removes both necessary
 * conditions:
 *  (i) a unit that is MOVING toward its destination receives only the
 *      TANGENTIAL projection of its accumulated displacement — no
 *      component along its approach axis (§A2.2);
 *  (ii) a unit inside the RELIEF BAND of a destination its FSM still
 *      treats as current receives exactly ZERO force (§A2.3) — inside
 *      the band its motion is steering's alone, bit-identical to the
 *      pre-slice baseline (NP2).
 * Anchors (STATE_HOLD, in-reach attackers) still never receive, and a
 * restrained unit's partner takes the full pair displacement (§A2.4).
 * Relief and projection are pure functions of registered fields,
 * derived per tick — no new persisted state (§9 stands).
 */
/** P13 visual bound: max per-unit displacement in one tick (world units). */
export const SEPARATION_CAP = 0.06
/** Fine-bucket cell size for the pass's neighbour search (§8 (ii));
 * must be >= the largest possible contact distance (treant pair: 1.8). */
const SEP_CELL_SIZE = 2
/** Bucket grid covers [-100, 100) on each axis (playfield is ±90). */
const SEP_GRID_MIN = -100
const SEP_GRID_CELLS = 100
/**
 * Amended §13 constant reporting: CAP = 0.06 (unchanged from the first
 * implementation — under the amended mechanism CAP is demoted to a
 * spread-rate knob: it sets rest-state spread speed and the maximum
 * tangential slide per tick; the convergence properties NP1/P7′ must
 * hold at CAP, CAP÷2 and 2×CAP, addendum §A2.5). C = 8 (neighbour
 * cap), surround slots = 12 (Math.ts). Relief band: per unit,
 * stopDist(destination) + max(2 × radius, SEPARATION_RELIEF_BAND_MIN)
 * — see destinationRelieved(). Destination-active state set:
 * STATE_MOVE (in transit), STATE_RETURN / STATE_MUSTER / STATE_DISARM
 * (in transit and on the arrival tick — the state itself is the
 * destination-current signal), STATE_GATHER / STATE_BUILD (in transit
 * and working).
 */
/** §8 budget: per-unit cap on initiated pair evaluations per tick. */
export const SEPARATION_NEIGHBOR_CAP = 8
/** Addendum §A2.3: floor of the relief band beyond a destination's
 * stop ring (the band is max(2 × radius, this) past stopDist). */
export const SEPARATION_RELIEF_BAND_MIN = 1.0
/** §5: attackRange at or below this is "short reach" (melee 2.1, treant 2.4). */
export const SHORT_REACH_MAX = 2.4
/** §4: the playfield extent (fog grid 180×180 centred on origin). */
const FIELD_LIMIT = 90

let separationEnabled = true
/** Test-only switch (design note §13): production code never calls this. */
export function setSeparationEnabledForTests(on: boolean): void {
  separationEnabled = on
}

let separationCap = SEPARATION_CAP
/** Test-only CAP override (addendum §A2.5 robustness band: the
 * convergence properties are measured at CAP, CAP÷2 and 2×CAP).
 * Production code never calls this; null restores SEPARATION_CAP. */
export function setSeparationCapForTests(cap: number | null): void {
  separationCap = cap ?? SEPARATION_CAP
}

const ROLE_NONE = 0
const ROLE_PARTICIPANT = 1
const ROLE_ANCHOR = 2
/** Addendum §A2.3: destination-relieved — exerts, never receives. */
const ROLE_RELIEVED = 3

/**
 * Index into SURROUND_OFFSETS for a coincident (zero-distance) pair.
 * The direction is a pure function of the two ids alone (§6.5): the
 * higher id separates along +v, the lower along −v, so swapping the
 * pair negates the direction and pair symmetry holds by construction.
 */
function coincidentSlot(lo: number, hi: number): number {
  return (((lo * 2654435761) ^ (hi * 2246822519)) >>> 0) % SURROUND_OFFSETS.length
}

/**
 * Destination relief (addendum §A2.3). A unit whose FSM still treats a
 * destination as current — in transit to it, or working at it — and
 * whose distance to that destination is within the relief band
 * receives NO separation force at all (it still exerts normally).
 * Inside the band the unit's motion is steering's alone, bit-identical
 * to the pre-slice baseline (NP2): steering's terminal step decays to
 * zero at the stop ring, so any nonzero sustained force inside the
 * band would recreate the park equilibrium — relief is exactly zero,
 * never a fade.
 *
 * Eligibility is by STATE SEMANTICS, never by mere position. The
 * destination-active set (reported per amended §13):
 *  - STATE_MOVE, in transit (moving = 1): the destination is the
 *    order point (targetX/targetZ) with the unit's stopDist. A MOVE
 *    unit with moving = 0 has finished its order (a completed rally)
 *    and is NOT relieved.
 *  - STATE_RETURN / STATE_MUSTER / STATE_DISARM: the destination is
 *    the targetId entity (hall / deposit building). Relief covers
 *    both moving forms: in transit (moving = 1) and the arrival tick
 *    itself (moving = 0, set by steering this same tick) — the gather
 *    pass resolves the state at the START of the next tick, so a unit
 *    the pass can see in one of these states still treats the
 *    destination as current either way. (The first implementation of
 *    this amendment gated these states on moving = 1 and displaced
 *    the worker on its arrival tick — NP2 caught it; the state, not
 *    the flag, is the destination-current signal here.)
 *  - STATE_GATHER / STATE_BUILD, in transit AND working: harvesting
 *    at the node and building at the site are stationary destination
 *    activity — the FSM keeps the destination current until the work
 *    ends (node depleted, site complete), so relief spans both.
 * Deliberately NOT relieved: STATE_PATROL (a waypoint is never
 * arrived-at-and-held; patrollers are movers under §A2.2) and
 * STATE_ATTACKMOVE / STATE_ATTACK (the live destination alternates
 * between the order point and chased entities; relief is defined over
 * move/work destinations — chasers receive tangential-only, §A5.2).
 * A unit whose order has completed (STATE_IDLE, a finished build's
 * released crew) is not relieved even inside a former band: the moment
 * the FSM's business with the destination ends, relief ends.
 */
function destinationRelieved(world: World, id: number): boolean {
  const st = world.state[id]
  let destX: number
  let destZ: number
  if (st === STATE_MOVE) {
    if (world.moving[id] !== 1) return false
    destX = world.targetX[id]
    destZ = world.targetZ[id]
  } else if (
    st === STATE_GATHER ||
    st === STATE_BUILD ||
    st === STATE_RETURN ||
    st === STATE_MUSTER ||
    st === STATE_DISARM
  ) {
    const t = world.targetId[id]
    if (t === NO_TARGET || t === id || !world.entities.has(t)) return false
    destX = world.positionX[t]
    destZ = world.positionZ[t]
  } else {
    return false
  }
  const band =
    world.stopDist[id] + Math.max(2 * world.radius[id], SEPARATION_RELIEF_BAND_MIN)
  const dx = destX - world.positionX[id]
  const dz = destZ - world.positionZ[id]
  return dx * dx + dz * dz <= band * band
}

/**
 * Participation class of an entity this tick (§3 + addendum §A2.3):
 * buildings, trees, mines, shrines and piles never take part;
 * STATE_HOLD units and short-reach attackers already in reach of
 * their target are anchors (they exert push but never receive it — a
 * held unit stays put, and a striking attacker can never be pushed
 * out of reach); destination-relieved units exert but never receive
 * (the relief class). Where both could apply the anchor rule governs
 * (§A5.2) — the checks run anchor-first; the state sets are disjoint
 * in practice.
 */
function separationRole(world: World, id: number): number {
  const kind = world.kind[id]
  if (kind !== KIND_WORKER && kind !== KIND_MELEE && kind !== KIND_RANGED && kind !== KIND_TREANT) {
    return ROLE_NONE
  }
  if (world.radius[id] <= 0) return ROLE_NONE
  if (world.state[id] === STATE_HOLD) return ROLE_ANCHOR
  const fighter =
    kind === KIND_MELEE || kind === KIND_TREANT || (kind === KIND_WORKER && world.isMilitia(id))
  if (fighter && world.attackRange[id] <= SHORT_REACH_MAX) {
    const t = world.targetId[id]
    if (
      t !== NO_TARGET &&
      t !== id &&
      world.entities.has(t) &&
      world.team[t] !== world.team[id] &&
      world.isAttackable(t)
    ) {
      const dist = Math.hypot(
        world.positionX[t] - world.positionX[id],
        world.positionZ[t] - world.positionZ[id],
      )
      if (dist <= world.attackRange[id] + world.radius[t]) return ROLE_ANCHOR
    }
  }
  if (destinationRelieved(world, id)) return ROLE_RELIEVED
  return ROLE_PARTICIPANT
}

export class MovementSystemImpl implements System {
  // Separation scratch — instance-owned, recomputed from sim state every
  // tick, never persisted and never hashed (design note §6/§9: the pass
  // is a pure function of the registered position/radius/state arrays).
  private sepDispX = new Float64Array(0)
  private sepDispZ = new Float64Array(0)
  private sepSel = new Int32Array(0)
  private sepSelCount = new Int32Array(0)
  private sepRole = new Uint8Array(0)
  private sepCandId = new Int32Array(0)
  private sepCandSeq = new Int32Array(0)
  private sepCandDist = new Float64Array(0)
  private sepCellCount = new Int32Array(0)
  private sepBucket = new Int32Array(0)
  private sepFillPtr = new Int32Array(0)
  /** Probe surface (tests/P11): pairs evaluated by the most recent pass. */
  separationPairsLastTick = 0
  /** Probe surface (tests/P11): largest per-unit initiated selection last pass. */
  separationMaxInitiatedLastTick = 0

  update(world: World, dt: number): void {
    const hash = world.spatialHash
    for (const id of world.entities.keys()) {
      if (world.moving[id] !== 1 || world.moveSpeed[id] <= 0) {
        world.velocityX[id] = 0
        world.velocityZ[id] = 0
        continue
      }
      const dx = world.targetX[id] - world.positionX[id]
      const dz = world.targetZ[id] - world.positionZ[id]
      const dist = Math.hypot(dx, dz)
      // Epsilon: without it, float rounding stalls units exactly at the boundary (Zeno).
      if (dist <= world.stopDist[id] + 1e-4) {
        world.moving[id] = 0
        world.velocityX[id] = 0
        world.velocityZ[id] = 0
        continue
      }
      // dist > stopDist >= 0 here, so dist > 0 and the division is safe.
      const speed = getEffectiveSpeed(world, id, hash)
      const step = Math.min(speed * dt, dist - world.stopDist[id])
      const nx = dx / dist
      const nz = dz / dist
      world.velocityX[id] = nx * speed
      world.velocityZ[id] = nz * speed
      world.positionX[id] += nx * step
      world.positionZ[id] += nz * step
    }
    if (separationEnabled) this.separate(world)
  }

  /**
   * The push-apart pass. Snapshot (Jacobi) accumulation: every pair
   * displacement is computed from the position set as steering left it,
   * accumulated per unit, and applied only after all pairs are
   * evaluated — the pass is a pure function of that position set.
   * Pairs are enumerated in world order; each unit's neighbour
   * selection is its SEPARATION_NEIGHBOR_CAP nearest overlapping
   * neighbours by (distance², spatial-hash sequence). A pair is
   * processed exactly once: from the lower-sequence endpoint when it
   * selected the other, otherwise from the endpoint that did select.
   * Pair shares follow the amended symmetry (§A2.4): a restrained
   * unit (anchor or destination-relieved) receives 0 and its partner
   * takes the full overlap; two unrestrained partners split it
   * exactly antisymmetrically. In the apply phase a MOVING unit's
   * accumulated displacement is projected onto the tangent of its
   * approach axis (§A2.2) before the cap, so the pass can never
   * oppose a mover's radial progress.
   */
  private separate(world: World): void {
    const cap = world.positionX.length
    if (this.sepDispX.length < cap) {
      this.sepDispX = new Float64Array(cap)
      this.sepDispZ = new Float64Array(cap)
      this.sepSel = new Int32Array(cap * SEPARATION_NEIGHBOR_CAP)
      this.sepSelCount = new Int32Array(cap)
      this.sepRole = new Uint8Array(cap)
      this.sepCandId = new Int32Array(cap)
      this.sepCandSeq = new Int32Array(cap)
      this.sepCandDist = new Float64Array(cap)
    }
    const hash = world.spatialHash
    const px = world.positionX
    const pz = world.positionZ
    const radius = world.radius
    const C = SEPARATION_NEIGHBOR_CAP

    for (const id of world.entities.keys()) {
      this.sepRole[id] = separationRole(world, id)
    }

    // Neighbour enumeration uses a fine bucketing built inside the
    // pass (note §8, hypothesis (ii)): the tick's SpatialHash has
    // 24-unit cells, so in a brawl each query yields O(n) candidates
    // and the distance filter — not the pair cap — dominates the cost
    // (measured: +0.98 ms/tick on the 200-unit grind vs the 0.30
    // budget). A 2-unit grid (cell >= max contact distance, treant
    // pair 1.8) bounds candidates to actual neighbours. Counting sort
    // in world order keeps bucket order = world order within a cell,
    // and the selection below sorts by (distance², hash sequence), so
    // the chosen neighbour set is independent of enumeration order.
    const GRID = SEP_GRID_CELLS
    if (this.sepCellCount.length < GRID * GRID + 1) {
      this.sepCellCount = new Int32Array(GRID * GRID + 1)
      this.sepBucket = new Int32Array(cap)
    }
    const counts = this.sepCellCount
    counts.fill(0)
    const cellKey = (x: number, z: number): number => {
      const cx = Math.min(GRID - 1, Math.max(0, Math.floor((x - SEP_GRID_MIN) / SEP_CELL_SIZE)))
      const cz = Math.min(GRID - 1, Math.max(0, Math.floor((z - SEP_GRID_MIN) / SEP_CELL_SIZE)))
      return cz * GRID + cx
    }
    for (const id of world.entities.keys()) {
      if (this.sepRole[id] === ROLE_NONE) continue
      counts[cellKey(px[id], pz[id])] += 1
    }
    // Prefix sums in place: counts[k] becomes the start offset of
    // cell k; counts[GRID*GRID] ends as the participant total.
    let acc = 0
    for (let k = 0; k < GRID * GRID; k += 1) {
      const n = counts[k]
      counts[k] = acc
      acc += n
    }
    counts[GRID * GRID] = acc
    if (this.sepBucket.length < acc) this.sepBucket = new Int32Array(acc)
    const fillPtr = this.sepFillPtr.length >= GRID * GRID ? this.sepFillPtr : new Int32Array(GRID * GRID)
    this.sepFillPtr = fillPtr
    fillPtr.set(counts.subarray(0, GRID * GRID))
    for (const id of world.entities.keys()) {
      if (this.sepRole[id] === ROLE_NONE) continue
      const key = cellKey(px[id], pz[id])
      this.sepBucket[fillPtr[key]] = id
      fillPtr[key] += 1
    }

    // Selection phase: positions are not written anywhere in this
    // phase or the processing phase, so every read sees the snapshot.
    for (const a of world.entities.keys()) {
      if (this.sepRole[a] === ROLE_NONE) {
        this.sepSelCount[a] = 0
        continue
      }
      let m = 0
      const acx = Math.min(GRID - 1, Math.max(0, Math.floor((px[a] - SEP_GRID_MIN) / SEP_CELL_SIZE)))
      const acz = Math.min(GRID - 1, Math.max(0, Math.floor((pz[a] - SEP_GRID_MIN) / SEP_CELL_SIZE)))
      for (let gz = Math.max(0, acz - 1); gz <= Math.min(GRID - 1, acz + 1); gz += 1) {
        for (let gx = Math.max(0, acx - 1); gx <= Math.min(GRID - 1, acx + 1); gx += 1) {
          const key = gz * GRID + gx
          const end = key + 1 <= GRID * GRID - 1 ? counts[key + 1] : counts[GRID * GRID]
          for (let s = counts[key]; s < end; s += 1) {
            const b = this.sepBucket[s]
            if (b === a) continue
            const dx = px[b] - px[a]
            const dz = pz[b] - pz[a]
            const distSq = dx * dx + dz * dz
            const contact = radius[a] + radius[b]
            if (distSq >= contact * contact) continue
            this.sepCandId[m] = b
            this.sepCandSeq[m] = hash.sequenceOf(b)
            this.sepCandDist[m] = distSq
            m += 1
          }
        }
      }
      const take = Math.min(m, C)
      for (let k = 0; k < take; k += 1) {
        let best = -1
        for (let j = 0; j < m; j += 1) {
          if (this.sepCandDist[j] === Infinity) continue
          if (
            best < 0 ||
            this.sepCandDist[j] < this.sepCandDist[best] ||
            (this.sepCandDist[j] === this.sepCandDist[best] &&
              this.sepCandSeq[j] < this.sepCandSeq[best])
          ) {
            best = j
          }
        }
        this.sepSel[a * C + k] = this.sepCandId[best]
        this.sepCandDist[best] = Infinity
      }
      this.sepSelCount[a] = take
    }

    // Processing phase: accumulate antisymmetric pair displacements.
    let pairs = 0
    let maxInitiated = 0
    for (const a of world.entities.keys()) {
      const selCount = this.sepSelCount[a]
      if (selCount > maxInitiated) maxInitiated = selCount
      if (this.sepRole[a] === ROLE_NONE) continue
      const seqA = hash.sequenceOf(a)
      for (let i = 0; i < selCount; i += 1) {
        const b = this.sepSel[a * C + i]
        // Exactly-once: the lower-sequence endpoint processes the pair
        // when it selected the other; if it did not, the selecting
        // endpoint processes it instead (detected by the reverse scan).
        if (seqA > hash.sequenceOf(b)) {
          let reverseSelected = false
          const bCount = this.sepSelCount[b]
          for (let j = 0; j < bCount; j += 1) {
            if (this.sepSel[b * C + j] === a) {
              reverseSelected = true
              break
            }
          }
          if (reverseSelected) continue
        }
        pairs += 1
        const roleA = this.sepRole[a]
        const roleB = this.sepRole[b]
        // Amended symmetry (§A2.4): restrained = anchor or relieved.
        const restrA = roleA === ROLE_ANCHOR || roleA === ROLE_RELIEVED
        const restrB = roleB === ROLE_ANCHOR || roleB === ROLE_RELIEVED
        if (restrA && restrB) continue
        const dx = px[a] - px[b]
        const dz = pz[a] - pz[b]
        const distSq = dx * dx + dz * dz
        const contact = radius[a] + radius[b]
        let ux: number
        let uz: number
        let overlap: number
        if (distSq < 1e-12) {
          // Coincident pair: no geometric direction exists; the
          // direction is a pure function of the two ids (§6.5).
          const lo = Math.min(a, b)
          const hi = Math.max(a, b)
          const v = SURROUND_OFFSETS[coincidentSlot(lo, hi)]
          const s = a === hi ? 1 : -1
          ux = v[0] * s
          uz = v[1] * s
          overlap = contact
        } else {
          const dist = Math.sqrt(distSq)
          ux = dx / dist
          uz = dz / dist
          overlap = contact - dist
        }
        if (overlap <= 0) continue
        const shareA = restrA ? 0 : restrB ? overlap : overlap / 2
        const shareB = restrB ? 0 : restrA ? overlap : overlap / 2
        this.sepDispX[a] += ux * shareA
        this.sepDispZ[a] += uz * shareA
        this.sepDispX[b] -= ux * shareB
        this.sepDispZ[b] -= uz * shareB
      }
    }

    // Apply phase: only ordinary participants receive (anchors and
    // destination-relieved units accumulated exactly 0 by the share
    // rule, and are skipped here). A moving unit's displacement is
    // first projected onto the tangent of its approach axis (§A2.2 —
    // the projection is linear, so projecting the accumulated sum is
    // projecting each pair share), then capped (P13), then the
    // displacement — never the position — is clamped to the field
    // (§4), so the pass can neither teleport a unit nor push one out
    // of the field.
    for (const a of world.entities.keys()) {
      if (this.sepRole[a] !== ROLE_PARTICIPANT) continue
      let dx = this.sepDispX[a]
      let dz = this.sepDispZ[a]
      this.sepDispX[a] = 0
      this.sepDispZ[a] = 0
      if (dx === 0 && dz === 0) continue
      if (world.moving[a] === 1) {
        const tx = world.targetX[a] - px[a]
        const tz = world.targetZ[a] - pz[a]
        const tl = Math.hypot(tx, tz)
        if (tl > 1e-9) {
          const ux = tx / tl
          const uz = tz / tl
          const radial = dx * ux + dz * uz
          dx -= radial * ux
          dz -= radial * uz
          if (dx === 0 && dz === 0) continue
        }
      }
      const mag = Math.hypot(dx, dz)
      if (mag > separationCap) {
        dx *= separationCap / mag
        dz *= separationCap / mag
      }
      const x = px[a]
      const z = pz[a]
      dx = x >= FIELD_LIMIT ? Math.min(dx, 0) : Math.min(dx, FIELD_LIMIT - x)
      dx = x <= -FIELD_LIMIT ? Math.max(dx, 0) : Math.max(dx, -FIELD_LIMIT - x)
      dz = z >= FIELD_LIMIT ? Math.min(dz, 0) : Math.min(dz, FIELD_LIMIT - z)
      dz = z <= -FIELD_LIMIT ? Math.max(dz, 0) : Math.max(dz, -FIELD_LIMIT - z)
      px[a] = x + dx
      pz[a] = z + dz
    }
    this.separationPairsLastTick = pairs
    this.separationMaxInitiatedLastTick = maxInitiated
  }
}

/** Order any unit to a point on the map. */
/**
 * Stop a unit: cancel movement, attacks, and other orders.
 * Workers also disarm auto-gather (HARVEST_OFF — the same mechanism an
 * explicit move order uses), so a stopped worker STAYS stopped instead of
 * walking straight back to a node on the next tick. A worker carrying
 * resources still walks home to deliver first (the gather FSM returns
 * carried loads before idling), then holds position until ordered.
 */
export function orderStop(world: World, id: number): void {
  world.moving[id] = 0
  world.velocityX[id] = 0
  world.velocityZ[id] = 0
  world.targetId[id] = NO_TARGET
  world.state[id] = STATE_IDLE
  if (world.kind[id] === KIND_WORKER) world.harvestKind[id] = HARVEST_OFF
}

export function orderMove(world: World, id: number, x: number, z: number): void {
  world.targetX[id] = x
  world.targetZ[id] = z
  world.stopDist[id] = 0.5
  world.moving[id] = 1
  world.state[id] = STATE_MOVE
  world.resumeX[id] = NaN
  world.resumeZ[id] = NaN
  // An explicit move order cancels auto-harvest: the worker holds position
  // on arrival instead of walking back to work. The Gather command re-arms it.
  if (world.kind[id] === KIND_WORKER) {
    world.harvestKind[id] = HARVEST_OFF
  }
}

/** Patrol between current position and target. Engages enemies encountered. */
export function orderPatrol(world: World, id: number, x: number, z: number): void {
  // Store origin in resume fields
  world.resumeX[id] = world.positionX[id]
  world.resumeZ[id] = world.positionZ[id]
  world.targetX[id] = x
  world.targetZ[id] = z
  world.stopDist[id] = 0.5
  world.moving[id] = 1
  world.state[id] = STATE_PATROL
}

/** Hold position: attack enemies in range but don't move. */
export function orderHold(world: World, id: number): void {
  world.moving[id] = 0
  world.velocityX[id] = 0
  world.velocityZ[id] = 0
  world.state[id] = STATE_HOLD
}
