/**
 * Lockstep wire protocol — deterministic, compact, versioned.
 *
 * Design notes:
 * - All multi-byte integers are varint-encoded (LEB128, unsigned) except
 *   coordinates, which are IEEE-754 f32 (bit-exact round-trip via DataView).
 * - The `step` field of Command is NOT transmitted: execution step is implied
 *   by the turn number (turn * STEPS_PER_TURN). The receiver re-stamps it.
 * - Magic + version byte lets us detect and reject mismatched builds instead
 *   of desyncing mysteriously.
 */
import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { Command } from '../session/commands.ts'

export const PROTOCOL_MAGIC = 0x4b // 'K'
export const PROTOCOL_VERSION = 1

/** Lockstep cadence: 4 turns/sec at 60Hz sim => 15 steps per turn. */
export const TURN_HZ = 4
export const STEPS_PER_TURN = 15

/** Default input delay in turns (how far ahead inputs are scheduled). */
export const DEFAULT_INPUT_DELAY_TURNS = 2

/** State hash exchange every N turns (40 turns = 10 sim-seconds). */
export const HASH_EVERY_TURNS = 40

export const MsgKind = {
  Hello: 0,
  Input: 1,
  Hash: 2,
  Ping: 3,
  Pong: 4,
  SnapshotRequest: 5,
  Snapshot: 6,
  Bye: 7,
  Ack: 8,
} as const
export type MsgKind = (typeof MsgKind)[keyof typeof MsgKind]

export interface HelloMsg {
  kind: typeof MsgKind.Hello
  playerIndex: number
  matchSeed: number
}

export interface InputMsg {
  kind: typeof MsgKind.Input
  turn: number
  player: number
  commands: Command[]
}

export interface HashMsg {
  kind: typeof MsgKind.Hash
  turn: number
  hash: bigint
}

export interface SnapshotRequestMsg {
  kind: typeof MsgKind.SnapshotRequest
  turn: number
}

export interface SnapshotMsg {
  kind: typeof MsgKind.Snapshot
  turn: number
  bytes: Uint8Array
}

export type NetMessage =
  | HelloMsg
  | InputMsg
  | HashMsg
  | SnapshotRequestMsg
  | SnapshotMsg
  | { kind: typeof MsgKind.Ping; seq: number; tSendMs: number }
  | { kind: typeof MsgKind.Pong; seq: number; tSendMs: number }
  | { kind: typeof MsgKind.Bye; reason: number }

// ---- enum <-> byte maps (fixed order = wire-stable) ----

const BUILDINGS: BuildingType[] = ['hall', 'barracks', 'archery', 'farm']
const UNITS: UnitType[] = ['worker', 'melee', 'ranged']

function buildingToByte(b: BuildingType): number {
  const i = BUILDINGS.indexOf(b)
  if (i < 0) throw new Error(`unknown building ${b}`)
  return i
}

function byteToBuilding(b: number): BuildingType {
  const t = BUILDINGS[b]
  if (t === undefined) throw new Error(`bad building byte ${b}`)
  return t
}

function unitToByte(u: UnitType): number {
  const i = UNITS.indexOf(u)
  if (i < 0) throw new Error(`unknown unit ${u}`)
  return i
}

function byteToUnit(b: number): UnitType {
  const t = UNITS[b]
  if (t === undefined) throw new Error(`bad unit byte ${b}`)
  return t
}

// ---- varint (unsigned LEB128) ----

export function varintSize(v: number): number {
  let n = 1
  let x = v >>> 0
  while (x >= 0x80) {
    x >>>= 7
    n += 1
  }
  return n
}

export function writeVarint(view: DataView, offset: number, v: number): number {
  let x = v >>> 0
  let o = offset
  while (x >= 0x80) {
    view.setUint8(o++, (x & 0x7f) | 0x80)
    x >>>= 7
  }
  view.setUint8(o++, x)
  return o
}

export function readVarint(view: DataView, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let o = offset
  for (;;) {
    const b = view.getUint8(o++)
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 35) throw new Error('varint overflow')
  }
  return { value: result >>> 0, next: o }
}

// ---- command codec ----

const CmdTag = {
  Move: 0,
  Attack: 1,
  AttackMove: 2,
  Gather: 3,
  Build: 4,
  Train: 5,
  Rally: 6,
  Patrol: 7,
} as const
type CmdTag = (typeof CmdTag)[keyof typeof CmdTag]

function cmdSize(cmd: Command): number {
  // Must exactly match writeCommand below: tag(1) + varint count +
  // varint ids + varint scalars + f32 coords + u8 enums.
  const idsSize = (ids: readonly number[]): number => {
    let n = varintSize(ids.length)
    for (const id of ids) n += varintSize(id)
    return n
  }
  switch (cmd.type) {
    case 'move':
    case 'attackmove':
    case 'patrol':
      return 1 + idsSize(cmd.unitIds) + 4 + 4
    case 'attack':
      return 1 + idsSize(cmd.unitIds) + varintSize(cmd.targetId)
    case 'gather':
      return 1 + idsSize(cmd.unitIds) + varintSize(cmd.nodeId)
    case 'build':
      return 1 + varintSize(cmd.workerId) + 1 + 4 + 4 + varintSize(cmd.siteId)
    case 'train':
      return 1 + varintSize(cmd.buildingId) + 1
    case 'rally':
      return 1 + varintSize(cmd.buildingId) + 4 + 4
  }
}

function writeIds(view: DataView, o: number, ids: readonly number[]): number {
  o = writeVarint(view, o, ids.length)
  for (const id of ids) o = writeVarint(view, o, id)
  return o
}

function readIds(view: DataView, o: number): { ids: number[]; next: number } {
  const c = readVarint(view, o)
  o = c.next
  const ids: number[] = []
  for (let i = 0; i < c.value; i += 1) {
    const v = readVarint(view, o)
    o = v.next
    ids.push(v.value)
  }
  return { ids, next: o }
}

function writeCommand(view: DataView, o: number, cmd: Command): number {
  switch (cmd.type) {
    case 'move':
      view.setUint8(o++, CmdTag.Move)
      o = writeIds(view, o, cmd.unitIds)
      view.setFloat32(o, cmd.x, true); o += 4
      view.setFloat32(o, cmd.z, true); o += 4
      return o
    case 'attack':
      view.setUint8(o++, CmdTag.Attack)
      o = writeIds(view, o, cmd.unitIds)
      o = writeVarint(view, o, cmd.targetId)
      return o
    case 'attackmove':
      view.setUint8(o++, CmdTag.AttackMove)
      o = writeIds(view, o, cmd.unitIds)
      view.setFloat32(o, cmd.x, true); o += 4
      view.setFloat32(o, cmd.z, true); o += 4
      return o
    case 'gather':
      view.setUint8(o++, CmdTag.Gather)
      o = writeIds(view, o, cmd.unitIds)
      o = writeVarint(view, o, cmd.nodeId)
      return o
    case 'build':
      view.setUint8(o++, CmdTag.Build)
      o = writeVarint(view, o, cmd.workerId)
      view.setUint8(o++, buildingToByte(cmd.building))
      view.setFloat32(o, cmd.x, true); o += 4
      view.setFloat32(o, cmd.z, true); o += 4
      o = writeVarint(view, o, cmd.siteId)
      return o
    case 'train':
      view.setUint8(o++, CmdTag.Train)
      o = writeVarint(view, o, cmd.buildingId)
      view.setUint8(o++, unitToByte(cmd.unit))
      return o
    case 'rally':
      view.setUint8(o++, CmdTag.Rally)
      o = writeVarint(view, o, cmd.buildingId)
      view.setFloat32(o, cmd.x, true); o += 4
      view.setFloat32(o, cmd.z, true); o += 4
      return o
    case 'patrol':
      view.setUint8(o++, CmdTag.Patrol)
      o = writeIds(view, o, cmd.unitIds)
      view.setFloat32(o, cmd.x, true); o += 4
      view.setFloat32(o, cmd.z, true); o += 4
      return o
  }
}

function readCommand(view: DataView, o: number): { cmd: Command; next: number } {
  const tag = view.getUint8(o++) as CmdTag
  switch (tag) {
    case CmdTag.Move: {
      const u = readIds(view, o); o = u.next
      const x = view.getFloat32(o, true); o += 4
      const z = view.getFloat32(o, true); o += 4
      return { cmd: { type: 'move', step: 0, unitIds: u.ids, x, z }, next: o }
    }
    case CmdTag.Attack: {
      const u = readIds(view, o); o = u.next
      const t = readVarint(view, o); o = t.next
      return { cmd: { type: 'attack', step: 0, unitIds: u.ids, targetId: t.value }, next: o }
    }
    case CmdTag.AttackMove: {
      const u = readIds(view, o); o = u.next
      const x = view.getFloat32(o, true); o += 4
      const z = view.getFloat32(o, true); o += 4
      return { cmd: { type: 'attackmove', step: 0, unitIds: u.ids, x, z }, next: o }
    }
    case CmdTag.Gather: {
      const u = readIds(view, o); o = u.next
      const n = readVarint(view, o); o = n.next
      return { cmd: { type: 'gather', step: 0, unitIds: u.ids, nodeId: n.value }, next: o }
    }
    case CmdTag.Build: {
      const w = readVarint(view, o); o = w.next
      const b = view.getUint8(o++)
      const x = view.getFloat32(o, true); o += 4
      const z = view.getFloat32(o, true); o += 4
      const s = readVarint(view, o); o = s.next
      return { cmd: { type: 'build', step: 0, workerId: w.value, building: byteToBuilding(b), x, z, siteId: s.value }, next: o }
    }
    case CmdTag.Train: {
      const b = readVarint(view, o); o = b.next
      const u = view.getUint8(o++)
      return { cmd: { type: 'train', step: 0, buildingId: b.value, unit: byteToUnit(u) }, next: o }
    }
    case CmdTag.Rally: {
      const b = readVarint(view, o); o = b.next
      const x = view.getFloat32(o, true); o += 4
      const z = view.getFloat32(o, true); o += 4
      return { cmd: { type: 'rally', step: 0, buildingId: b.value, x, z }, next: o }
    }
    case CmdTag.Patrol: {
      const u = readIds(view, o); o = u.next
      const x = view.getFloat32(o, true); o += 4
      const z = view.getFloat32(o, true); o += 4
      return { cmd: { type: 'patrol', step: 0, unitIds: u.ids, x, z }, next: o }
    }
    default:
      throw new Error(`unknown command tag ${tag}`)
  }
}

// ---- message encode / decode ----

function writeU64(view: DataView, o: number, v: bigint): number {
  view.setUint32(o, Number(v & 0xffffffffn), true); o += 4
  view.setUint32(o, Number((v >> 32n) & 0xffffffffn), true); o += 4
  return o
}

function readU64(view: DataView, o: number): { value: bigint; next: number } {
  const lo = view.getUint32(o, true); o += 4
  const hi = view.getUint32(o, true); o += 4
  return { value: (BigInt(hi) << 32n) | BigInt(lo), next: o }
}

/** Exact encoded size (so we can allocate once). */
export function messageSize(msg: NetMessage): number {
  switch (msg.kind) {
    case MsgKind.Hello:
      return 1 + 1 + 1 + 1 + 4
    case MsgKind.Input: {
      let n = 1 + varintSize(msg.turn) + 1 + varintSize(msg.commands.length)
      for (const c of msg.commands) n += cmdSize(c)
      return n
    }
    case MsgKind.Hash:
      return 1 + varintSize(msg.turn) + 8
    case MsgKind.Ping:
    case MsgKind.Pong:
      return 1 + 4 + 8
    case MsgKind.SnapshotRequest:
      return 1 + varintSize(msg.turn)
    case MsgKind.Snapshot:
      return 1 + varintSize(msg.turn) + varintSize(msg.bytes.length) + msg.bytes.length
    case MsgKind.Bye:
      return 1 + 1
  }
  // Note: MsgKind.Ack is transport-internal and never reaches this layer.
}

export function encodeMessage(msg: NetMessage): Uint8Array {
  const buf = new Uint8Array(messageSize(msg))
  const view = new DataView(buf.buffer)
  let o = 0
  view.setUint8(o++, msg.kind)
  switch (msg.kind) {
    case MsgKind.Hello:
      view.setUint8(o++, PROTOCOL_MAGIC)
      view.setUint8(o++, PROTOCOL_VERSION)
      view.setUint8(o++, msg.playerIndex)
      view.setUint32(o, msg.matchSeed >>> 0, true); o += 4
      break
    case MsgKind.Input:
      o = writeVarint(view, o, msg.turn)
      view.setUint8(o++, msg.player)
      o = writeVarint(view, o, msg.commands.length)
      for (const c of msg.commands) o = writeCommand(view, o, c)
      break
    case MsgKind.Hash:
      o = writeVarint(view, o, msg.turn)
      o = writeU64(view, o, msg.hash)
      break
    case MsgKind.Ping:
      view.setUint32(o, msg.seq >>> 0, true); o += 4
      o = writeU64(view, o, BigInt(msg.tSendMs))
      break
    case MsgKind.Pong:
      view.setUint32(o, msg.seq >>> 0, true); o += 4
      o = writeU64(view, o, BigInt(msg.tSendMs))
      break
    case MsgKind.SnapshotRequest:
      o = writeVarint(view, o, msg.turn)
      break
    case MsgKind.Snapshot:
      o = writeVarint(view, o, msg.turn)
      o = writeVarint(view, o, msg.bytes.length)
      buf.set(msg.bytes, o); o += msg.bytes.length
      break
    case MsgKind.Bye:
      view.setUint8(o++, msg.reason)
      break
  }
  // Note: MsgKind.Ack is transport-internal and never reaches this layer.
  if (o !== buf.length) throw new Error(`encode size mismatch ${o} != ${buf.length}`)
  return buf
}

export function decodeMessage(data: Uint8Array): NetMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 0
  const kind = view.getUint8(o++) as MsgKind
  switch (kind) {
    case MsgKind.Hello: {
      const magic = view.getUint8(o++)
      const version = view.getUint8(o++)
      if (magic !== PROTOCOL_MAGIC) throw new Error(`bad magic ${magic}`)
      if (version !== PROTOCOL_VERSION) throw new Error(`protocol version mismatch: got ${version}, want ${PROTOCOL_VERSION}`)
      const playerIndex = view.getUint8(o++)
      const matchSeed = view.getUint32(o, true); o += 4
      return { kind, playerIndex, matchSeed }
    }
    case MsgKind.Input: {
      const t = readVarint(view, o); o = t.next
      const player = view.getUint8(o++)
      const c = readVarint(view, o); o = c.next
      const commands: Command[] = []
      for (let i = 0; i < c.value; i += 1) {
        const r = readCommand(view, o); o = r.next
        commands.push(r.cmd)
      }
      return { kind, turn: t.value, player, commands }
    }
    case MsgKind.Hash: {
      const t = readVarint(view, o); o = t.next
      const h = readU64(view, o); o = h.next
      return { kind, turn: t.value, hash: h.value }
    }
    case MsgKind.Ping: {
      const seq = view.getUint32(o, true); o += 4
      const t = readU64(view, o)
      return { kind, seq, tSendMs: Number(t.value) }
    }
    case MsgKind.Pong: {
      const seq = view.getUint32(o, true); o += 4
      const t = readU64(view, o)
      return { kind, seq, tSendMs: Number(t.value) }
    }
    case MsgKind.SnapshotRequest: {
      const t = readVarint(view, o)
      return { kind, turn: t.value }
    }
    case MsgKind.Snapshot: {
      const t = readVarint(view, o); o = t.next
      const l = readVarint(view, o); o = l.next
      const bytes = data.slice(o, o + l.value)
      if (bytes.length !== l.value) throw new Error('snapshot truncated')
      return { kind, turn: t.value, bytes }
    }
    case MsgKind.Bye: {
      const reason = view.getUint8(o++)
      return { kind, reason }
    }
    default:
      throw new Error(`unknown message kind ${kind}`)
  }
}
