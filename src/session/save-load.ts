import type { World } from '../core/World'
import type { FactionId } from '../data/factions.ts'
import type { Command } from './commands.ts'

const SAVE_VERSION = 1
const SAVE_KEY = 'kingdoms-rts-save'

/** All typed-array fields serialized by name. */
const ARRAY_FIELDS = [
  'positionX', 'positionY', 'positionZ',
  'velocityX', 'velocityY', 'velocityZ',
  'kind', 'team', 'state',
  'health', 'maxHealth', 'damage', 'attackRange', 'sight', 'cooldown', 'cooldownTotal',
  'moving', 'moveSpeed', 'targetX', 'targetZ', 'stopDist', 'radius',
  'targetId',
  'carryKind', 'carryAmount', 'carryMax', 'gatherTimer', 'amount',
  'buildProgress', 'buildTotal', 'buildAuto',
  'trainKind', 'trainLeft', 'trainTotal', 'rallyX', 'rallyZ',
  'harvestKind', 'bellsRung', 'militiaUntil', 'tier', 'upgradeLeft', 'shrineHeld',
] as const

interface WorldSave {
  version: number
  step: number
  maxId: number
  entities: number[]
  arrays: Record<string, number[]>
  gold: number[]
  wood: number[]
  supplyUsed: number[]
  supplyCap: number[]
  factionOfTeam: [FactionId, FactionId]
  winner: -1 | 0 | 1
  matchTime: number
  season: number
  militiaCooldown: number[]
  soulAsh: number[]
  warCharge: number[]
  warLastTick: number[]
  rallyKind: number[]
  rallyUntil: number[]
  victoryPoints: number[]
  fog: number[][]
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
    const arr = world[name] as ArrayLike<number>
    const out: number[] = new Array(maxId + 1)
    for (let i = 0; i <= maxId; i += 1) out[i] = arr[i]
    arrays[name] = out
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
    factionOfTeam: [...world.factionOfTeam] as [FactionId, FactionId],
    winner: world.winner,
    matchTime: world.matchTime,
    season: world.season,
    militiaCooldown: [...world.militiaCooldown],
    soulAsh: [...world.soulAsh],
    warCharge: [...world.warCharge],
    warLastTick: [...world.warLastTick],
    rallyKind: [...world.rallyKind],
    rallyUntil: [...world.rallyUntil],
    victoryPoints: [...world.victoryPoints],
    fog: world.fog.map((f) => f.snapshotCells()),
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
    const arr = world[name] as ArrayLike<number> & { [i: number]: number }
    const data = save.arrays[name]
    if (!data) continue
    const n = Math.min(data.length, maxId + 1)
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
  world.factionOfTeam = [...save.factionOfTeam] as [FactionId, FactionId]
  world.winner = save.winner
  world.matchTime = save.matchTime ?? 0
  // Older saves predate the Season Wheel and stay in the growing season.
  world.season = save.season ?? 0
  world.militiaCooldown = save.militiaCooldown ? [...save.militiaCooldown] : [0, 0]
  world.soulAsh = save.soulAsh ? [...save.soulAsh] : [0, 0]
  world.warCharge = save.warCharge ? [...save.warCharge] : [0, 0]
  world.warLastTick = save.warLastTick ? [...save.warLastTick] : [0, 0]
  world.rallyKind = save.rallyKind ? [...save.rallyKind] : [0, 0]
  world.rallyUntil = save.rallyUntil ? [...save.rallyUntil] : [0, 0]
  world.victoryPoints = save.victoryPoints ? [...save.victoryPoints] : [1000, 1000]
  // bellsRung rides in ARRAY_FIELDS; older saves predate it and stay unrung.
  save.fog.forEach((cells, i) => {
    if (world.fog[i]) world.fog[i].restoreCells(cells)
  })
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
