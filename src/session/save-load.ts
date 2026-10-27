import type { World } from '../core/World'
import { NO_TRAINING } from '../core/World'
import {
  WORLD_ENTITY_ARRAYS,
  entityArrayOf,
} from '../core/state-registry.ts'
import type { FactionId } from '../data/factions.ts'
import type { Command } from './commands.ts'

const SAVE_VERSION = 1
const SAVE_KEY = 'kingdoms-rts-save'

/**
 * Per-entity typed arrays serialized through the [0..maxId] window, and
 * the fixed/full-length ones serialized whole — both derived from the
 * state registry (core/state-registry.ts), the single source of truth
 * the hash and snapshot also consume. Before the 2026-10-24 unification
 * this was a third hand-maintained list: it dropped resumeX/resumeZ
 * (worker return-to-work targets) and reanimateTicks/momentumTicks/
 * lastCombatTick (loaded reanimated units never crumbled).
 */
const ARRAY_FIELDS: readonly string[] = WORLD_ENTITY_ARRAYS
  .filter((s) => s.saveWindow === 'entity')
  .map((s) => s.name)
const FULL_FIELDS: readonly string[] = WORLD_ENTITY_ARRAYS
  .filter((s) => s.saveWindow === 'full')
  .map((s) => s.name)

export interface WorldSave {
  version: number
  step: number
  maxId: number
  entities: number[]
  arrays: Record<string, number[]>
  gold: number[]
  wood: number[]
  supplyUsed: number[]
  supplyCap: number[]
  /**
   * Researched upgrade levels. Optional because saves written before
   * the 2026-10-24 registry unification did not carry them at all (a
   * mid-game reload silently reset research to 0); those load as
   * [0, 0]. New saves always write them.
   */
  meleeDmgLvl?: number[]
  meleeHpLvl?: number[]
  rangedDmgLvl?: number[]
  factionOfTeam: [FactionId, FactionId]
  winner: -1 | 0 | 1
  matchTime: number
  season: number
  wildHeat: number[]
  wildSiteX: number[]
  wildSiteZ: number[]
  wildWorker: number[]
  militiaCooldown: number[]
  soulAsh: number[]
  warCharge: number[]
  warLastTick: number[]
  rallyKind: number[]
  rallyUntil: number[]
  victoryPoints: number[]
  fog: number[][]
  fogVisibleNow: number[][]
  commands: readonly Command[]
}

function maxEntityId(world: World): number {
  let max = 0
  for (const id of world.entities.keys()) if (id > max) max = id
  return max
}

/** Capture the full simulation state plus the command log. */
export function serializeWorld(world: World, step: number, commands: readonly Command[]): WorldSave {
  const maxId = maxEntityId(world)
  const arrays: Record<string, number[]> = {}
  for (const name of ARRAY_FIELDS) {
    const arr = entityArrayOf(world, name)
    const out: number[] = new Array(maxId + 1)
    for (let i = 0; i <= maxId; i += 1) out[i] = arr[i]
    arrays[name] = out
  }
  // Full-length fields are not indexed by entity id over their length
  // (queue slots run to buildingId * TRAIN_QUEUE_WAITING + slot, past
  // maxId; bellsRung is a fixed 3), so they serialize whole.
  for (const name of FULL_FIELDS) {
    arrays[name] = Array.from(entityArrayOf(world, name))
  }
  return {
    version: SAVE_VERSION,
    step,
    maxId,
    entities: [...world.entities.keys()],
    arrays,
    gold: [...world.gold],
    wood: [...world.wood],
    supplyUsed: [...world.supplyUsed],
    supplyCap: [...world.supplyCap],
    meleeDmgLvl: [...world.meleeDmgLvl],
    meleeHpLvl: [...world.meleeHpLvl],
    rangedDmgLvl: [...world.rangedDmgLvl],
    factionOfTeam: [...world.factionOfTeam] as [FactionId, FactionId],
    winner: world.winner,
    matchTime: world.matchTime,
    season: world.season,
    wildHeat: [...world.wildHeat],
    wildSiteX: [...world.wildSiteX],
    wildSiteZ: [...world.wildSiteZ],
    wildWorker: [...world.wildWorker],
    militiaCooldown: [...world.militiaCooldown],
    soulAsh: [...world.soulAsh],
    warCharge: [...world.warCharge],
    warLastTick: [...world.warLastTick],
    rallyKind: [...world.rallyKind],
    rallyUntil: [...world.rallyUntil],
    victoryPoints: [...world.victoryPoints],
    fog: world.fog.map((f) => f.snapshotCells()),
    fogVisibleNow: world.fog.map((f) => f.snapshotVisibleNow()),
    commands: commands.map((c) => ({ ...c })),
  }
}

/** Restore a saved state into an existing world (in place). */
export function deserializeWorld(world: World, save: WorldSave): void {
  if (save.version !== SAVE_VERSION) {
    throw new Error(`Unsupported save version ${save.version}`)
  }
  const { maxId } = save
  for (const name of ARRAY_FIELDS) {
    const arr = entityArrayOf(world, name)
    const data = save.arrays[name]
    if (!data) continue
    const n = Math.min(data.length, maxId + 1)
    for (let i = 0; i < n; i += 1) arr[i] = data[i]
  }
  for (const name of FULL_FIELDS) {
    const arr = entityArrayOf(world, name)
    const data = save.arrays[name]
    // Queue slots: reset first (older saves predate the queue and
    // restore as empty), then copy the saved slots in full. Other
    // full-length fields (bellsRung) just copy what the save carries.
    if (name === 'trainQueueKind') arr.fill(NO_TRAINING)
    if (!data) continue
    const n = Math.min(data.length, arr.length)
    for (let i = 0; i < n; i += 1) arr[i] = data[i]
  }
  world.entities.clear()
  for (const id of save.entities) world.entities.set(id, { id })
  world.setNextEntityId(maxId + 1)
  world.rebuildFreeIds(maxId)
  world.gold = [...save.gold]
  world.wood = [...save.wood]
  world.supplyUsed = [...save.supplyUsed]
  world.supplyCap = [...save.supplyCap]
  // Saves predating the registry unification carry no research levels.
  world.meleeDmgLvl = save.meleeDmgLvl ? [...save.meleeDmgLvl] : [0, 0]
  world.meleeHpLvl = save.meleeHpLvl ? [...save.meleeHpLvl] : [0, 0]
  world.rangedDmgLvl = save.rangedDmgLvl ? [...save.rangedDmgLvl] : [0, 0]
  world.factionOfTeam = [...save.factionOfTeam] as [FactionId, FactionId]
  world.winner = save.winner
  world.matchTime = save.matchTime ?? 0
  // Older saves predate the Season Wheel and stay in the growing season.
  world.season = save.season ?? 0
  // Older saves predate the Living Wild: no pressure, no remembered site.
  world.wildHeat = save.wildHeat ? [...save.wildHeat] : [0, 0]
  world.wildSiteX = save.wildSiteX ? [...save.wildSiteX] : [0, 0]
  world.wildSiteZ = save.wildSiteZ ? [...save.wildSiteZ] : [0, 0]
  world.wildWorker = save.wildWorker ? [...save.wildWorker] : [-1, -1]
  world.militiaCooldown = save.militiaCooldown ? [...save.militiaCooldown] : [0, 0]
  world.soulAsh = save.soulAsh ? [...save.soulAsh] : [0, 0]
  world.warCharge = save.warCharge ? [...save.warCharge] : [0, 0]
  world.warLastTick = save.warLastTick ? [...save.warLastTick] : [0, 0]
  world.rallyKind = save.rallyKind ? [...save.rallyKind] : [0, 0]
  world.rallyUntil = save.rallyUntil ? [...save.rallyUntil] : [0, 0]
  world.victoryPoints = save.victoryPoints ? [...save.victoryPoints] : [1000, 1000]
  // bellsRung rides in FULL_FIELDS; older saves predate it and stay unrung.
  save.fog.forEach((cells, i) => {
    if (world.fog[i]) world.fog[i].restoreCells(cells)
  })
  // Fog's pending demotions (visibleNow) are hashed sim state: without
  // them the restored world's next vision update diverges from an
  // uninterrupted run. Saves that predate the field restore empty.
  world.fog.forEach((fog, i) => {
    fog.restoreVisibleNow(save.fogVisibleNow?.[i] ?? [])
  })
  // A legacy save can carry a dead building's production state on a
  // recycled id (the A3c/F2 defect); scrub what each kind can't hold.
  world.scrubRestoredState()
}

/** Persist a save to localStorage. Returns false when storage is unavailable. */
export function writeSave(world: World, step: number, commands: readonly Command[]): boolean {
  try {
    const data = serializeWorld(world, step, commands)
    localStorage.setItem(SAVE_KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/** Delete the save from localStorage. */
export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/** Read a save from localStorage, or null when none exists / corrupt. */
export function readSave(): WorldSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as WorldSave
    if (data.version !== SAVE_VERSION || !Array.isArray(data.entities)) return null
    return data
  } catch {
    return null
  }
}

export function hasSave(): boolean {
  return readSave() !== null
}

/** Load a save into the world; returns the command log and step, or null. */
export function loadIntoWorld(
  world: World,
  save: WorldSave,
): { step: number; commands: readonly Command[] } {
  deserializeWorld(world, save)
  return { step: save.step, commands: save.commands.map((c) => ({ ...c })) }
}
