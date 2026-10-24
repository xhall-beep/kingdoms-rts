/**
 * Deterministic 64-bit state hash (FNV-1a) over the full simulation state.
 *
 * Used for lockstep desync detection: every HASH_EVERY_TURNS turns both peers
 * hash and compare. Any divergence — a single flipped bit anywhere in the sim
 * state — produces a different hash.
 *
 * Rules:
 * - Covers every registered sim field (see core/state-registry.ts: entity
 *   arrays, per-team arrays, scalars) plus entity ids, the id counter and
 *   free-id count, factions, and both fog grids (cells + visibleNow).
 * - Excludes visual-only state (damageNumbers, hitFlashes, deathPops,
 *   completionFlashes — explicitly not sim state).
 * - NaN is canonicalized to a fixed constant: two NaNs with different bit
 *   patterns (possible via different float ops) still hash identically.
 *   (In a correct deterministic sim this never triggers, but it removes a
 *   whole class of false-positive desyncs.)
 *
 * History: before the 2026-10-24 registry unification this file hand-listed
 * 37 of the World's 49 typed arrays and none of the per-team endgame state
 * (victoryPoints, soulAsh, warCharge…) — desyncs in those fields were
 * invisible. The field list now comes from the registry, and
 * state-coverage.test.ts fails if a World field is unregistered.
 */
import type { World } from '../core/World.ts'
import {
  WORLD_ENTITY_ARRAYS,
  WORLD_TEAM_ARRAYS,
  WORLD_SCALARS,
  entityArrayOf,
  teamArrayOf,
  scalarOf,
} from '../core/state-registry.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

const scratch = new DataView(new ArrayBuffer(4))

function mixWord(h: bigint, word: number): bigint {
  return ((h ^ BigInt(word >>> 0)) * FNV_PRIME) & MASK64
}

/** Hash a float bit-pattern, canonicalizing NaN. */
function mixFloat(h: bigint, v: number): bigint {
  if (v !== v) return mixWord(h, 0x7fc00000)
  scratch.setFloat32(0, v, true)
  return mixWord(h, scratch.getUint32(0, true))
}

function mixFloatArray(h: bigint, a: Float32Array): bigint {
  for (let i = 0; i < a.length; i += 1) h = mixFloat(h, a[i])
  return h
}

function mixUint8Array(h: bigint, a: Uint8Array): bigint {
  // Pack 4 bytes per mix for speed.
  let i = 0
  const n4 = a.length - (a.length % 4)
  for (; i < n4; i += 4) {
    const w = a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)
    h = mixWord(h, w)
  }
  let tail = 0
  let shift = 0
  for (; i < a.length; i += 1, shift += 8) tail |= a[i] << shift
  return mixWord(h, tail)
}

function mixInt32Array(h: bigint, a: Int32Array): bigint {
  for (let i = 0; i < a.length; i += 1) h = mixWord(h, a[i] >>> 0)
  return h
}

function mixInt8Array(h: bigint, a: Int8Array): bigint {
  for (let i = 0; i < a.length; i += 1) h = mixWord(h, a[i] & 0xff)
  return h
}

function mixString(h: bigint, s: string): bigint {
  h = mixWord(h, s.length)
  for (let i = 0; i < s.length; i += 1) h = mixWord(h, s.charCodeAt(i))
  return h
}

/** Hash the complete deterministic simulation state of a world. */
export function hashWorldState(world: World): bigint {
  let h = FNV_OFFSET

  // Entity identity: count + sorted ids + id counter + free-id count
  // (future ids depend on both).
  h = mixWord(h, world.entities.size)
  const ids = [...world.entities.keys()].sort((a, b) => a - b)
  for (const id of ids) h = mixWord(h, id)
  h = mixWord(h, world.getNextEntityId())
  h = mixWord(h, world.getFreeIdCount())

  // Struct-of-arrays state — every registered entity array, mixed with
  // the per-kind mixer the pre-registry list used for that array type.
  for (const spec of WORLD_ENTITY_ARRAYS) {
    const a = entityArrayOf(world, spec.name)
    if (spec.kind === 'f32') h = mixFloatArray(h, a as Float32Array)
    else if (spec.kind === 'u8') h = mixUint8Array(h, a as Uint8Array)
    else if (spec.kind === 'i8') h = mixInt8Array(h, a as Int8Array)
    else h = mixInt32Array(h, a as Int32Array)
  }

  // Fog grids (both teams): cells + pending demotions (visibleNow).
  // visibleNow is NOT covered by snapshotCells — omitting it causes
  // post-resync divergence on the next vision update.
  for (const fog of world.fog) {
    h = mixUint8Array(h, new Uint8Array(fog.snapshotCells()))
    const vn = fog.snapshotVisibleNow()
    h = mixWord(h, vn.length)
    for (const i of vn) h = mixWord(h, i)
  }

  // VictorySystem check timer (internal sim state).
  for (const s of world.systems) {
    if (s instanceof VictorySystemImpl) {
      h = mixFloat(h, s.getTimer())
      break
    }
  }

  // ShrineSystem check timer (internal sim state, same treatment — it
  // phases when capture checks and VP drains fire).
  for (const s of world.systems) {
    if (s instanceof ShrineSystemImpl) {
      h = mixFloat(h, s.getTimer())
      break
    }
  }

  // Per-team arrays (economy, upgrade levels, Living Wild, Militia,
  // Soul-Ash, War Horn, Victory Points) — mixed element-wise as floats.
  for (const name of WORLD_TEAM_ARRAYS) {
    for (const v of teamArrayOf(world, name)) h = mixFloat(h, v)
  }

  // Factions (strings).
  h = mixString(h, world.factionOfTeam[0])
  h = mixString(h, world.factionOfTeam[1])

  // Scalars: tick / matchTime / season / winner. tick drives the
  // deterministic combat rolls and matchTime drives the Bells, militia
  // windows and rally expiries — both joined the hash with the registry
  // unification (the pre-registry hash omitted them).
  for (const spec of WORLD_SCALARS) {
    const v = scalarOf(world, spec.name)
    h = spec.kind === 'float' ? mixFloat(h, v) : mixWord(h, v >>> 0)
  }

  return h
}

/** Hex rendering for logs (16 chars, zero-padded). */
export function hashToHex(h: bigint): string {
  return h.toString(16).padStart(16, '0')
}
