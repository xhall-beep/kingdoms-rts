/**
 * Full world snapshot → bytes → world. Used for lockstep desync resync
 * (phase 1: the session harness; phase 2+: over the wire via SnapshotMsg).
 *
 * Layout: magic + version, id counter + free-id stack, entity id list,
 * then every registered entity array raw (core/state-registry.ts order),
 * fog cells + visibleNow, victory timer, per-team arrays as f64, scalars,
 * faction strings. Floats are copied bit-exact (no rounding), so restore
 * is deterministic and hash-exact (state-coverage.test.ts proves it on
 * non-default state).
 *
 * Version history:
 * - v2: + fog visibleNow + victory timer.
 * - v3 (registry unification, audit 2026-10-24): the array set comes from
 *   the registry — v2 silently omitted 10 entity arrays (bellsRung,
 *   buildAuto, carryMax, lastCombatTick, militiaUntil, momentumTicks,
 *   reanimateTicks, shrineHeld, tier, upgradeLeft), season + the Living
 *   Wild set (which the hash DID cover — a resync could therefore never
 *   repair a season/wild desync), the per-team endgame arrays (VP,
 *   Soul-Ash, War Horn, militia cooldown, upgrade levels), tick /
 *   matchTime, and the free-id stack (allocation order after a resync
 *   diverged from the sender's). v3 carries all of it.
 */
import { World } from '../core/World.ts'
import type { FactionId } from '../data/factions.ts'
import {
  WORLD_ENTITY_ARRAYS,
  WORLD_TEAM_ARRAYS,
  WORLD_SCALARS,
  entityArrayOf,
  teamArrayOf,
  scalarOf,
  setScalar,
} from '../core/state-registry.ts'
import { VictorySystemImpl } from '../systems/victory.ts'

const SNAP_MAGIC = 0x534e4150 // 'SNAP'
const SNAP_VERSION = 3

function victoryTimerOf(world: World): number {
  for (const s of world.systems) {
    if (s instanceof VictorySystemImpl) return s.getTimer()
  }
  return 0
}

function setVictoryTimer(world: World, t: number): void {
  for (const s of world.systems) {
    if (s instanceof VictorySystemImpl) {
      s.setTimer(t)
      return
    }
  }
}

function byteLengthOf(world: World): number {
  let n = 4 + 4 // magic + version
  n += 4 // nextEntityId
  n += 4 + world.getFreeIdCount() * 4 // free-id stack
  n += 4 + world.entities.size * 4 // entity count + ids
  for (const spec of WORLD_ENTITY_ARRAYS) {
    n += entityArrayOf(world, spec.name).byteLength
  }
  n += world.fog[0].snapshotCells().length
  n += world.fog[1].snapshotCells().length
  n += 4 + world.fog[0].snapshotVisibleNow().length * 4
  n += 4 + world.fog[1].snapshotVisibleNow().length * 4
  n += 8 // victory timer f64
  n += WORLD_TEAM_ARRAYS.length * 2 * 8 // per-team arrays × 2 teams × f64
  n += WORLD_SCALARS.length * 8 // scalars, one f64 slot each
  n += 2 + world.factionOfTeam[0].length // faction strings (u16 len + ascii)
  n += 2 + world.factionOfTeam[1].length
  return n
}

export function snapshotWorld(world: World): Uint8Array {
  const buf = new Uint8Array(byteLengthOf(world))
  const view = new DataView(buf.buffer)
  let o = 0
  const putU32 = (v: number): void => {
    view.setUint32(o, v >>> 0, true)
    o += 4
  }
  const putArray = (a: ArrayBufferView): void => {
    buf.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o)
    o += a.byteLength
  }
  const putF64Arr = (a: number[]): void => {
    for (const v of a) {
      view.setFloat64(o, v, true)
      o += 8
    }
  }

  view.setUint32(o, SNAP_MAGIC, true); o += 4
  view.setUint32(o, SNAP_VERSION, true); o += 4
  putU32(world.getNextEntityId())
  const freeIds = world.getFreeIds()
  putU32(freeIds.length)
  for (const id of freeIds) putU32(id)
  const ids = [...world.entities.keys()]
  putU32(ids.length)
  for (const id of ids) putU32(id)

  for (const spec of WORLD_ENTITY_ARRAYS) putArray(entityArrayOf(world, spec.name))

  putArray(new Uint8Array(world.fog[0].snapshotCells()))
  putArray(new Uint8Array(world.fog[1].snapshotCells()))
  for (const fog of world.fog) {
    const vn = fog.snapshotVisibleNow()
    putU32(vn.length)
    for (const i of vn) putU32(i)
  }
  view.setFloat64(o, victoryTimerOf(world), true); o += 8

  for (const name of WORLD_TEAM_ARRAYS) putF64Arr(teamArrayOf(world, name))
  for (const spec of WORLD_SCALARS) {
    view.setFloat64(o, scalarOf(world, spec.name), true)
    o += 8
  }
  for (const f of world.factionOfTeam) {
    view.setUint16(o, f.length, true); o += 2
    for (let i = 0; i < f.length; i += 1) buf[o++] = f.charCodeAt(i) & 0x7f
  }

  if (o !== buf.length) throw new Error(`snapshot size mismatch ${o} != ${buf.length}`)
  return buf
}

export function restoreWorld(world: World, data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 0
  const getU32 = (): number => {
    const v = view.getUint32(o, true)
    o += 4
    return v
  }
  const getArray = (dst: ArrayBufferView & { set(a: ArrayLike<number>): void }): void => {
    const src = new Uint8Array(data.buffer, data.byteOffset + o, dst.byteLength)
    new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(src)
    o += dst.byteLength
  }

  if (getU32() !== SNAP_MAGIC) throw new Error('bad snapshot magic')
  if (getU32() !== SNAP_VERSION) throw new Error('snapshot version mismatch')
  world.setNextEntityId(getU32())
  const freeCount = getU32()
  const freeIds: number[] = []
  for (let i = 0; i < freeCount; i += 1) freeIds.push(getU32())
  world.restoreFreeIds(freeIds)
  const count = getU32()
  world.entities.clear()
  for (let i = 0; i < count; i += 1) {
    const id = getU32()
    world.entities.set(id, { id })
  }

  for (const spec of WORLD_ENTITY_ARRAYS) {
    getArray(entityArrayOf(world, spec.name) as ArrayBufferView & { set(a: ArrayLike<number>): void })
  }

  const fogLen = world.fog[0].snapshotCells().length
  world.fog[0].restoreCells(Array.from(data.slice(o, o + fogLen)))
  o += fogLen
  world.fog[1].restoreCells(Array.from(data.slice(o, o + fogLen)))
  o += fogLen
  for (const fog of world.fog) {
    const n = getU32()
    const vn: number[] = []
    for (let i = 0; i < n; i += 1) vn.push(getU32())
    fog.restoreVisibleNow(vn)
  }
  setVictoryTimer(world, view.getFloat64(o, true)); o += 8

  const getF64Arr = (dst: number[]): void => {
    for (let i = 0; i < dst.length; i += 1) {
      dst[i] = view.getFloat64(o, true)
      o += 8
    }
  }
  for (const name of WORLD_TEAM_ARRAYS) getF64Arr(teamArrayOf(world, name))
  for (const spec of WORLD_SCALARS) {
    setScalar(world, spec.name, view.getFloat64(o, true))
    o += 8
  }
  const factions: string[] = []
  for (let f = 0; f < 2; f += 1) {
    const len = view.getUint16(o, true); o += 2
    let s = ''
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(data[o++])
    factions.push(s)
  }
  world.factionOfTeam = [factions[0] as FactionId, factions[1] as FactionId]

  if (o !== data.length) throw new Error(`snapshot restore size mismatch ${o} != ${data.length}`)
}
