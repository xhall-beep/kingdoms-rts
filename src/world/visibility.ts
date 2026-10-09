import type { World } from '../core/World'
import { FOG_UNEXPLORED, FOG_VISIBLE } from './fog'

/** True if `team` can currently see this entity. Own entities are always visible. */
export function canSee(world: World, team: 0 | 1, id: number): boolean {
  if (world.team[id] === team) return true
  const fog = world.fog[team]
  const x = world.positionX[id]
  const z = world.positionZ[id]
  if (fog.stateAt(x, z) === FOG_VISIBLE) return true
  // Large footprints (structures) count as seen if any edge point is visible.
  const r = world.radius[id]
  return (
    r > 0 &&
    (fog.stateAt(x + r, z) === FOG_VISIBLE ||
      fog.stateAt(x - r, z) === FOG_VISIBLE ||
      fog.stateAt(x, z + r) === FOG_VISIBLE ||
      fog.stateAt(x, z - r) === FOG_VISIBLE)
  )
}

/** True if `team` has ever seen the ground at this point. */
export function isExplored(world: World, team: 0 | 1, x: number, z: number): boolean {
  return world.fog[team].stateAt(x, z) !== FOG_UNEXPLORED
}
