/**
 * Deterministic 64-bit state hash (FNV-1a) over the full simulation state.
 *
 * Used for lockstep desync detection: every HASH_EVERY_TURNS turns both peers
 * hash and compare. Any divergence — a single flipped bit anywhere in the sim
 * state — produces a different hash.
 *
 * Rules:
 * - Covers every typed array in World plus entity ids, the id counter,
 *   economy, factions, winner, and both fog grids.
 * - Excludes visual-only state (damageNumbers — explicitly not sim state).
 * - NaN is canonicalized to a fixed constant: two NaNs with different bit
 *   patterns (possible via different float ops) still hash identically.
 *   (In a correct deterministic sim this never triggers, but it removes a
 *   whole class of false-positive desyncs.)
 */
import type { World } from '../core/World.ts'
import { VictorySystemImpl } from '../systems/victory.ts'

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

  // Entity identity: count + sorted ids + id counter (future ids depend on it).
  h = mixWord(h, world.entities.size)
  const ids = [...world.entities.keys()].sort((a, b) => a - b)
  for (const id of ids) h = mixWord(h, id)
  h = mixWord(h, world.getNextEntityId())

  // Struct-of-arrays state.
  h = mixFloatArray(h, world.positionX)
  h = mixFloatArray(h, world.positionY)
  h = mixFloatArray(h, world.positionZ)
  h = mixFloatArray(h, world.velocityX)
  h = mixFloatArray(h, world.velocityY)
  h = mixFloatArray(h, world.velocityZ)
  h = mixUint8Array(h, world.kind)
  h = mixUint8Array(h, world.team)
  h = mixUint8Array(h, world.state)
  h = mixFloatArray(h, world.health)
  h = mixFloatArray(h, world.maxHealth)
  h = mixFloatArray(h, world.damage)
  h = mixFloatArray(h, world.attackRange)
  h = mixFloatArray(h, world.sight)
  h = mixFloatArray(h, world.cooldown)
  h = mixFloatArray(h, world.cooldownTotal)
  h = mixUint8Array(h, world.moving)
  h = mixFloatArray(h, world.moveSpeed)
  h = mixFloatArray(h, world.targetX)
  h = mixFloatArray(h, world.targetZ)
  h = mixFloatArray(h, world.stopDist)
  h = mixFloatArray(h, world.radius)
  h = mixInt32Array(h, world.targetId)
  h = mixUint8Array(h, world.carryKind)
  h = mixFloatArray(h, world.carryAmount)
  h = mixFloatArray(h, world.gatherTimer)
  h = mixFloatArray(h, world.amount)
  h = mixFloatArray(h, world.buildProgress)
  h = mixFloatArray(h, world.buildTotal)
  h = mixInt8Array(h, world.trainKind)
  h = mixFloatArray(h, world.trainLeft)
  h = mixFloatArray(h, world.trainTotal)
  h = mixFloatArray(h, world.rallyX)
  h = mixFloatArray(h, world.rallyZ)
  h = mixUint8Array(h, world.harvestKind)
  h = mixFloatArray(h, world.resumeX)
  h = mixFloatArray(h, world.resumeZ)

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

  // Economy / meta.
  for (const arr of [
    world.gold,
    world.wood,
    world.meleeDmgLvl,
    world.meleeHpLvl,
    world.rangedDmgLvl,
    world.supplyUsed,
    world.supplyCap,
  ]) {
    for (const v of arr) h = mixFloat(h, v)
  }
  h = mixString(h, world.factionOfTeam[0])
  h = mixString(h, world.factionOfTeam[1])
  h = mixWord(h, (world.winner + 1) >>> 0)

  return h
}

/** Hex rendering for logs (16 chars, zero-padded). */
export function hashToHex(h: bigint): string {
  return h.toString(16).padStart(16, '0')
}
