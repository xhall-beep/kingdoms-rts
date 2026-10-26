/**
 * PvP match-opening handshake + deterministic world reset.
 *
 * The bug: a PvP match started from whatever live single-player state each
 * phone happened to be in — different units, resources, matchTime, bell
 * progress, tick counters. Lockstep then hashed divergent worlds and cried
 * desync on the first verified turn (or silently ran mismatched Season
 * Wheel flips, since season IS hashed but matchTime is not).
 *
 * The fix: turn 0 carries one `pvp-setup` command per side, each declaring
 * the faction that side will play. The lockstep barrier guarantees both
 * declarations are present before turn 0 executes, so both peers run
 * resetWorldForMatch with the identical faction pair and start the match
 * from bit-identical state — no shared-settings assumption required.
 */
import { World } from '../core/World.ts'
import { WORLD_ENTITY_ARRAYS } from '../core/state-registry.ts'
import type { FactionId } from '../data/factions.ts'
import { FACTION_IDS } from '../data/factions.ts'
import { seedScenario } from '../scenario.ts'
import { deserializeWorld, type WorldSave } from '../session/save-load.ts'
import type { Command } from '../session/commands.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'

/**
 * Every per-entity typed-array field on World — derived from the state
 * registry (core/state-registry.ts), the same list the hash, snapshot,
 * and save/load consume. The desync hash covers the FULL arrays (whole
 * capacity, not just live slots), so the reset must restore all of
 * them — stale data in a dead slot would hash differently per peer.
 * If World gains a new typed-array field, register it in the registry
 * (the coverage tests in pvp-setup.test.ts and state-coverage.test.ts
 * fail until you do) and it lands here automatically.
 */
export const PVP_SETUP_ENTITY_ARRAYS: readonly string[] =
  WORLD_ENTITY_ARRAYS.map((s) => s.name)

/**
 * Reset the world to a pristine, deterministic match start.
 *
 * - Restores scalars/economy/fog from the boot snapshot (replay-proven path).
 * - Restores every per-entity array in full to constructor-pristine values,
 *   clears entities, restarts id allocation from 1 (spawn order is then
 *   identical on both peers).
 * - Resets sim-clock state the save format doesn't carry: world.tick
 *   (drives deterministic combat rolls), researched upgrade levels, and the
 *   victory/shrine system timers (the latter drive hashed VP state).
 * - Applies the agreed faction pair BEFORE seeding, because spawn stats
 *   (faction mods, worker carry capacity) are baked in at spawn time.
 */
export function resetWorldForMatch(
  world: World,
  pristineSave: WorldSave,
  factions: [FactionId, FactionId],
): void {
  deserializeWorld(world, pristineSave)

  // The desync hash covers the FULL arrays (whole capacity), so every slot
  // must be restored — including constructor-level fills that are NOT zero
  // (trainKind=NO_TRAINING, resumeX=NaN, …). Fill values are read from a
  // fresh World so they track the constructor automatically.
  const pristine = new World()
  for (const name of PVP_SETUP_ENTITY_ARRAYS) {
    const arr = world[name as keyof World] as unknown as { fill(v: number): void }
    const ref = pristine[name as keyof World] as unknown as ArrayLike<number>
    arr.fill(ref[0])
  }
  // Fog's pending-visibility set is hashed but not part of the save payload;
  // a restore must clear it (the boot snapshot was captured with it empty).
  for (const fog of world.fog) fog.restoreVisibleNow([])

  world.entities.clear()
  world.setNextEntityId(1)
  world.rebuildFreeIds(0)

  world.tick = 0
  world.supplyUsed = [0, 0]
  world.supplyCap = [0, 0]
  world.meleeDmgLvl = [0, 0]
  world.meleeHpLvl = [0, 0]
  world.rangedDmgLvl = [0, 0]
  // Visual-only, but a stale hit flash rendering one frame into a fresh
  // match is sloppy; clearing is free.
  world.damageNumbers.length = 0
  world.hitFlashes.length = 0
  world.deathPops.length = 0
  world.completionFlashes.length = 0
  world.alertEvents.length = 0
  world.lastAttackAlertTick.fill(-1000000)

  for (const s of world.systems) {
    if (s instanceof VictorySystemImpl) s.setTimer(0)
    else if (s instanceof ShrineSystemImpl) s.resetTimer()
  }

  world.factionOfTeam = [factions[0], factions[1]]
  seedScenario(world, factions[0], factions[1])
}

/** Match-opening handshake state (per PvPGame instance, never sim state). */
export interface PvpSetupHandshake {
  factions: [FactionId | null, FactionId | null]
  seeded: boolean
}

export function createPvpSetupHandshake(): PvpSetupHandshake {
  return { factions: [null, null], seeded: false }
}

/**
 * Feed one turn-0 `pvp-setup` command into the handshake. Returns the agreed
 * faction pair the moment both sides are known (and marks the handshake
 * seeded); otherwise null. Late, duplicate, or invalid declarations are
 * ignored deterministically — both peers apply the same rule, so they can
 * never disagree about whether the world was reseeded.
 */
export function notePvpSetupCommand(
  hs: PvpSetupHandshake,
  cmd: Extract<Command, { type: 'pvp-setup' }>,
): [FactionId, FactionId] | null {
  if (hs.seeded) return null
  if (cmd.player !== 0 && cmd.player !== 1) return null
  if (!FACTION_IDS.includes(cmd.faction)) return null
  if (hs.factions[cmd.player] !== null) return null
  hs.factions[cmd.player] = cmd.faction
  const [f0, f1] = hs.factions
  if (f0 !== null && f1 !== null) {
    hs.seeded = true
    return [f0, f1]
  }
  return null
}

/**
 * Read a faction id from localStorage, falling back to `fallback` when the
 * stored value is missing or not a known faction. Used for the local side's
 * match-setup declaration (PvP) and practice-vs-AI seeding.
 */
export function readFactionSetting(key: string, fallback: FactionId): FactionId {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    raw = null
  }
  if (raw !== null && (FACTION_IDS as readonly string[]).includes(raw)) {
    return raw as FactionId
  }
  return fallback
}
