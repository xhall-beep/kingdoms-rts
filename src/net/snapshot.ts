/**
 * Full world snapshot → bytes → world. Used for lockstep desync resync
 * (phase 1: the session harness; phase 2+: over the wire via SnapshotMsg).
 *
 * Layout: magic + version, then every typed array raw, then entity id list,
 * id counter, economy, factions, winner, fog cells. Floats are copied
 * bit-exact (no rounding), so restore is deterministic.
 */
import { World } from '../core/World.ts'
import type { FactionId } from '../data/factions.ts'
import { VictorySystemImpl } from '../systems/victory.ts'

const SNAP_MAGIC = 0x534e4150 // 'SNAP'
const SNAP_VERSION = 2 // v2: + fog visibleNow + victory timer

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
  n += 4 // entity count
  n += world.entities.size * 4 // entity ids
  n += world.positionX.byteLength
  n += world.positionY.byteLength
  n += world.positionZ.byteLength
  n += world.velocityX.byteLength
  n += world.velocityY.byteLength
  n += world.velocityZ.byteLength
  n += world.kind.byteLength
  n += world.team.byteLength
  n += world.state.byteLength
  n += world.health.byteLength
  n += world.maxHealth.byteLength
  n += world.damage.byteLength
  n += world.attackRange.byteLength
  n += world.sight.byteLength
  n += world.cooldown.byteLength
  n += world.cooldownTotal.byteLength
  n += world.moving.byteLength
  n += world.moveSpeed.byteLength
  n += world.targetX.byteLength
  n += world.targetZ.byteLength
  n += world.stopDist.byteLength
  n += world.radius.byteLength
  n += world.targetId.byteLength
  n += world.carryKind.byteLength
  n += world.carryAmount.byteLength
  n += world.gatherTimer.byteLength
  n += world.amount.byteLength
  n += world.buildProgress.byteLength
  n += world.buildTotal.byteLength
  n += world.trainKind.byteLength
  n += world.trainLeft.byteLength
  n += world.trainTotal.byteLength
  n += world.rallyX.byteLength
  n += world.rallyZ.byteLength
  n += world.harvestKind.byteLength
  n += world.resumeX.byteLength
  n += world.resumeZ.byteLength
  n += world.fog[0].snapshotCells().length
  n += world.fog[1].snapshotCells().length
  n += 4 + world.fog[0].snapshotVisibleNow().length * 4
  n += 4 + world.fog[1].snapshotVisibleNow().length * 4
  n += 8 // victory timer f64
  n += 7 * 2 * 8 // 7 economy arrays × 2 teams × f64
  n += 2 + world.factionOfTeam[0].length // faction strings (u16 len + ascii)
  n += 2 + world.factionOfTeam[1].length
  n += 4 // winner
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
  const putBytes = (a: Uint8Array): void => {
    buf.set(a, o)
    o += a.byteLength
  }
  const putF32 = (a: Float32Array): void => putBytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
  const putF64Arr = (a: number[]): void => {
    for (const v of a) {
      view.setFloat64(o, v, true)
      o += 8
    }
  }

  view.setUint32(o, SNAP_MAGIC, true); o += 4
  view.setUint32(o, SNAP_VERSION, true); o += 4
  putU32(world.getNextEntityId())
  const ids = [...world.entities.keys()]
  putU32(ids.length)
  for (const id of ids) putU32(id)

  putF32(world.positionX); putF32(world.positionY); putF32(world.positionZ)
  putF32(world.velocityX); putF32(world.velocityY); putF32(world.velocityZ)
  putBytes(world.kind); putBytes(world.team); putBytes(world.state)
  putF32(world.health); putF32(world.maxHealth); putF32(world.damage)
  putF32(world.attackRange); putF32(world.sight)
  putF32(world.cooldown); putF32(world.cooldownTotal)
  putBytes(world.moving)
  putF32(world.moveSpeed); putF32(world.targetX); putF32(world.targetZ)
  putF32(world.stopDist); putF32(world.radius)
  putBytes(new Uint8Array(world.targetId.buffer, world.targetId.byteOffset, world.targetId.byteLength))
  putBytes(world.carryKind)
  putF32(world.carryAmount); putF32(world.gatherTimer); putF32(world.amount)
  putF32(world.buildProgress); putF32(world.buildTotal)
  putBytes(new Uint8Array(world.trainKind.buffer, world.trainKind.byteOffset, world.trainKind.byteLength))
  putF32(world.trainLeft); putF32(world.trainTotal)
  putF32(world.rallyX); putF32(world.rallyZ)
  putBytes(world.harvestKind)
  putF32(world.resumeX); putF32(world.resumeZ)

  putBytes(new Uint8Array(world.fog[0].snapshotCells()))
  putBytes(new Uint8Array(world.fog[1].snapshotCells()))
  for (const fog of world.fog) {
    const vn = fog.snapshotVisibleNow()
    putU32(vn.length)
    for (const i of vn) putU32(i)
  }
  view.setFloat64(o, victoryTimerOf(world), true); o += 8

  putF64Arr(world.gold); putF64Arr(world.wood)
  putF64Arr(world.meleeDmgLvl); putF64Arr(world.meleeHpLvl); putF64Arr(world.rangedDmgLvl)
  putF64Arr(world.supplyUsed); putF64Arr(world.supplyCap)
  for (const f of world.factionOfTeam) {
    view.setUint16(o, f.length, true); o += 2
    for (let i = 0; i < f.length; i += 1) buf[o++] = f.charCodeAt(i) & 0x7f
  }
  view.setInt32(o, world.winner, true); o += 4

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
  const getBytes = (n: number): Uint8Array => {
    const s = data.slice(o, o + n)
    o += n
    return s
  }
  const getF32 = (dst: Float32Array): void => {
    dst.set(new Float32Array(data.buffer, data.byteOffset + o, dst.length))
    o += dst.byteLength
  }

  if (getU32() !== SNAP_MAGIC) throw new Error('bad snapshot magic')
  if (getU32() !== SNAP_VERSION) throw new Error('snapshot version mismatch')
  world.setNextEntityId(getU32())
  const count = getU32()
  world.entities.clear()
  for (let i = 0; i < count; i += 1) {
    const id = getU32()
    world.entities.set(id, { id })
  }

  getF32(world.positionX); getF32(world.positionY); getF32(world.positionZ)
  getF32(world.velocityX); getF32(world.velocityY); getF32(world.velocityZ)
  world.kind.set(getBytes(world.kind.byteLength))
  world.team.set(getBytes(world.team.byteLength))
  world.state.set(getBytes(world.state.byteLength))
  getF32(world.health); getF32(world.maxHealth); getF32(world.damage)
  getF32(world.attackRange); getF32(world.sight)
  getF32(world.cooldown); getF32(world.cooldownTotal)
  world.moving.set(getBytes(world.moving.byteLength))
  getF32(world.moveSpeed); getF32(world.targetX); getF32(world.targetZ)
  getF32(world.stopDist); getF32(world.radius)
  world.targetId.set(new Int32Array(getBytes(world.targetId.byteLength).buffer))
  world.carryKind.set(getBytes(world.carryKind.byteLength))
  getF32(world.carryAmount); getF32(world.gatherTimer); getF32(world.amount)
  getF32(world.buildProgress); getF32(world.buildTotal)
  world.trainKind.set(new Int8Array(getBytes(world.trainKind.byteLength).buffer))
  getF32(world.trainLeft); getF32(world.trainTotal)
  getF32(world.rallyX); getF32(world.rallyZ)
  world.harvestKind.set(getBytes(world.harvestKind.byteLength))
  getF32(world.resumeX); getF32(world.resumeZ)

  const fogLen = world.fog[0].snapshotCells().length
  world.fog[0].restoreCells(Array.from(getBytes(fogLen)))
  world.fog[1].restoreCells(Array.from(getBytes(fogLen)))
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
  getF64Arr(world.gold); getF64Arr(world.wood)
  getF64Arr(world.meleeDmgLvl); getF64Arr(world.meleeHpLvl); getF64Arr(world.rangedDmgLvl)
  getF64Arr(world.supplyUsed); getF64Arr(world.supplyCap)
  const factions: string[] = []
  for (let f = 0; f < 2; f += 1) {
    const len = view.getUint16(o, true); o += 2
    let s = ''
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(data[o++])
    factions.push(s)
  }
  world.factionOfTeam = [factions[0] as FactionId, factions[1] as FactionId]
  world.winner = view.getInt32(o, true) as -1 | 0 | 1; o += 4

  if (o !== data.length) throw new Error(`snapshot restore size mismatch ${o} != ${data.length}`)
}
