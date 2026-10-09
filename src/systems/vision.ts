import type { System, World } from '../core/World'

/**
 * Recomputes both teams' fog grids from unit sight ranges every step.
 * Each entity reveals for its own team only.
 */
export class VisionSystemImpl implements System {
  update(world: World, _dt: number): void {
    world.fog[0].beginUpdate()
    world.fog[1].beginUpdate()
    for (const id of world.entities.keys()) {
      const sight = world.sight[id]
      if (sight <= 0) continue
      const team = world.team[id] as 0 | 1
      world.fog[team].reveal(world.positionX[id], world.positionZ[id], sight)
    }
  }
}
