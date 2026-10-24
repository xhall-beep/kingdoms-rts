/**
 * Canonical registry of World's simulation state — the SINGLE source of
 * truth for "what is sim state".
 *
 * History (audit 2026-10-24, code-health §1 + perf §4.3): the field list
 * existed in four hand-maintained copies of three different lengths —
 * hashWorldState and snapshotWorld covered 37 of 49 typed arrays,
 * save/load 43, and only the PvP match reset covered all 49. The drift
 * was silent: headers claimed full coverage while desync detection was
 * blind to 17 sim-active fields, resync snapshots could not restore
 * them, and save/load dropped reanimate timers (loaded reanimated units
 * never crumbled). Every serializer now derives from this module, and
 * state-coverage.test.ts reflects over a live World and fails if any
 * field is missing here — the hole cannot silently reopen.
 *
 * Adding sim state to World? Add it HERE (entity array, team array, or
 * scalar); hash, snapshot, save/load, and the PvP reset pick it up
 * automatically. Genuinely non-sim state goes in WORLD_EXCLUDED_FIELDS
 * with a reason, where the coverage test can see the decision.
 */
import type { World } from './World.ts'

export type TypedArrayKind = 'f32' | 'u8' | 'i8' | 'i32'

export interface EntityArraySpec {
  readonly name: string
  readonly kind: TypedArrayKind
  /**
   * How save/load windows the field:
   * - 'entity': per-entity slots [0..maxId] (the common case);
   * - 'full': the array is NOT indexed by entity id over its whole
   *   length (trainQueueKind is indexed buildingId * TRAIN_QUEUE_WAITING
   *   + slot; bellsRung is a fixed length-3 match array) — serialized
   *   whole instead of through the per-entity window.
   */
  readonly saveWindow: 'entity' | 'full'
}

const ent = (name: string, kind: TypedArrayKind): EntityArraySpec => ({
  name,
  kind,
  saveWindow: 'entity',
})
const full = (name: string, kind: TypedArrayKind): EntityArraySpec => ({
  name,
  kind,
  saveWindow: 'full',
})

/**
 * Every per-entity typed array on World, in declaration order.
 * (bellsRung is the one fixed-length member: a per-match Uint8Array(3)
 * living alongside the per-entity arrays; it is state all the same.)
 */
export const WORLD_ENTITY_ARRAYS: readonly EntityArraySpec[] = [
  // spatial
  ent('positionX', 'f32'), ent('positionY', 'f32'), ent('positionZ', 'f32'),
  ent('velocityX', 'f32'), ent('velocityY', 'f32'), ent('velocityZ', 'f32'),
  // identity
  ent('kind', 'u8'), ent('team', 'u8'), ent('state', 'u8'),
  // combat
  ent('health', 'f32'), ent('maxHealth', 'f32'), ent('damage', 'f32'),
  ent('attackRange', 'f32'), ent('sight', 'f32'),
  ent('cooldown', 'f32'), ent('cooldownTotal', 'f32'),
  // movement orders
  ent('moving', 'u8'), ent('moveSpeed', 'f32'),
  ent('targetX', 'f32'), ent('targetZ', 'f32'),
  ent('stopDist', 'f32'), ent('radius', 'f32'),
  // targeting
  ent('targetId', 'i32'),
  // workers
  ent('carryKind', 'u8'), ent('carryAmount', 'f32'), ent('carryMax', 'f32'),
  ent('gatherTimer', 'f32'), ent('amount', 'f32'),
  // construction
  ent('buildProgress', 'f32'), ent('buildTotal', 'f32'), ent('buildAuto', 'u8'),
  // production (active slot + waiting queue)
  ent('trainKind', 'i8'), ent('trainLeft', 'f32'), ent('trainTotal', 'f32'),
  full('trainQueueKind', 'i8'), ent('trainQueueLen', 'u8'),
  ent('rallyX', 'f32'), ent('rallyZ', 'f32'),
  // worker harvest preference
  ent('harvestKind', 'u8'),
  // attack-move destination
  ent('resumeX', 'f32'), ent('resumeZ', 'f32'),
  // match meta stored in arrays
  full('bellsRung', 'u8'),
  ent('militiaUntil', 'f32'),
  ent('tier', 'u8'), ent('upgradeLeft', 'f32'),
  ent('shrineHeld', 'i8'),
  ent('reanimateTicks', 'i32'), ent('momentumTicks', 'i32'),
  ent('lastCombatTick', 'i32'),
]

/**
 * Per-team number arrays on World (index 0 = player, 1 = enemy).
 * All are sim state: hashed element-wise, snapshotted as f64s, and
 * saved as named WorldSave fields.
 */
export const WORLD_TEAM_ARRAYS: readonly string[] = [
  'gold', 'wood',
  'meleeDmgLvl', 'meleeHpLvl', 'rangedDmgLvl',
  'supplyUsed', 'supplyCap',
  'wildHeat', 'wildSiteX', 'wildSiteZ', 'wildWorker',
  'militiaCooldown',
  'soulAsh',
  'warCharge', 'warLastTick',
  'rallyKind', 'rallyUntil',
  'victoryPoints',
]

export type ScalarKind = 'int' | 'float'

export interface ScalarSpec {
  readonly name: string
  readonly kind: ScalarKind
}

/** Scalar (single-number) sim state on World. */
export const WORLD_SCALARS: readonly ScalarSpec[] = [
  { name: 'tick', kind: 'int' },
  { name: 'matchTime', kind: 'float' },
  { name: 'season', kind: 'int' },
  { name: 'winner', kind: 'int' },
]

/**
 * World fields that are deliberately NOT in the registry, with reasons.
 * The coverage test asserts every World field is either registered or
 * listed here — an entry here is a decision, not an omission.
 */
export const WORLD_EXCLUDED_FIELDS: Readonly<Record<string, string>> = {
  // Visual-only event queues; World.ts marks them "not sim state, not
  // serialized", and the renderer consumes them per-frame.
  damageNumbers: 'visual-only',
  hitFlashes: 'visual-only',
  deathPops: 'visual-only',
  completionFlashes: 'visual-only',
  // Fog grids are sim state but not typed arrays: all three serializers
  // cover them through FogGrid.snapshotCells/snapshotVisibleNow, and the
  // round-trip tests exercise them. They cannot join a typed-array list.
  fog: 'serialized via FogGrid snapshotCells/snapshotVisibleNow in all three consumers',
  // The entity id set itself: covered structurally (count + sorted ids)
  // by hash, and as an explicit id list by snapshot and save/load.
  entities: 'the id set is serialized structurally by every consumer',
  // Derived index, rebuilt from positions at the top of every update();
  // never authoritative state (World.ts says so explicitly).
  spatialHash: 'derived state, rebuilt every tick',
  // System instances are behavior, not state. The two pieces of internal
  // system state that ARE sim state — the victory check timer and the
  // shrine check timer — are carried explicitly by hash and snapshot
  // (each beside the other, via getTimer/setTimer); no other system
  // keeps sim state outside the World fields above.
  systems: 'behavior, not state (victory + shrine check timers carried explicitly by hash/snapshot)',
  // Config, not state: fixed at construction, identical on all peers.
  capacity: 'construction-time config',
  // Private id-allocation internals. The counter is covered through
  // getNextEntityId() by hash (mixed), snapshot (stored), and save/load
  // (stored as maxId + 1). The free-id STACK is covered exactly by
  // snapshot (v3 carries it verbatim) and by hash via getFreeIdCount();
  // save/load and the PvP reset deliberately REBUILD it from the entity
  // set (World.rebuildFreeIds) — the established design for those paths.
  nextEntityId: 'covered via getNextEntityId() in all three consumers',
  freeIds: 'snapshot carries it verbatim (v3); hash covers its count; save/load rebuilds it',
  // Faction ids (strings): covered by hash (mixed as strings), snapshot
  // (stored), and save/load (stored) — just not numeric state.
  factionOfTeam: 'string state, covered explicitly by all three consumers',
}

/** Typed-array view of a World field, for serializer loops. */
export type AnyTypedArray = Float32Array | Uint8Array | Int8Array | Int32Array

export function entityArrayOf(world: World, name: string): AnyTypedArray {
  return (world as unknown as Record<string, AnyTypedArray>)[name]
}

export function teamArrayOf(world: World, name: string): number[] {
  return (world as unknown as Record<string, number[]>)[name]
}

export function scalarOf(world: World, name: string): number {
  return (world as unknown as Record<string, number>)[name]
}

export function setScalar(world: World, name: string, value: number): void {
  ;(world as unknown as Record<string, number>)[name] = value
}
