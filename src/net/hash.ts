/**
 * Deterministic state hashing for desync detection.
 *
 * Every 40 turns, both clients hash their sim state and compare.
 * The hash covers: entity positions, health, resources, and game time.
 * It must be identical on both clients if the sim is deterministic.
 */

import type { World } from '../core/World.ts'

/** FNV-1a 32-bit hash (fast, deterministic). */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Hash the deterministic game state.
 * Covers: all entities (id, kind, team, x, z, hp), resources, supply, winner.
 */
export function hashWorld(world: World): number {
  const parts: string[] = []

  // Entities (sorted by id for determinism)
  const ids = [...world.entities.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    parts.push(
      `${id}:${world.kind[id]}:${world.team[id]}:` +
      `${world.positionX[id].toFixed(3)},${world.positionZ[id].toFixed(3)}:` +
      `${Math.floor(world.health[id])}`
    )
  }

  // Resources and game state
  parts.push(`g:${world.gold[0]},${world.gold[1]}`)
  parts.push(`w:${world.wood[0]},${world.wood[1]}`)
  parts.push(`s:${world.supplyUsed[0]},${world.supplyUsed[1]}`)
  parts.push(`win:${world.winner}`)

  return fnv1a(parts.join('|'))
}
