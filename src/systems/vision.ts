import type { System, World } from '../core/World'

/**
 * Vision recompute cadence, in sim ticks: fog is recomputed every 6th tick
 * (10 Hz at the 60 ticks/sec sim rate) instead of every tick. Fog changes
 * slowly and the AI thinks every 0.5–2 s, so consumers tolerate a few ticks
 * of staleness — while the every-tick recompute measured 80–93% of total
 * tick cost. Tick-count based (world.tick), never wall-clock, so lockstep
 * peers stay in parity. Phase: World.update increments tick before running
 * systems, so the gate fires on ticks 1, 7, 13, … — the first update of a
 * match reveals immediately, exactly as the every-tick version did.
 */
export const VISION_UPDATE_INTERVAL = 6

/**
 * Recomputes both teams' fog grids from unit sight ranges, on the cadence
 * above. Each entity reveals for its own team only.
 */
export class VisionSystemImpl implements System {
  update(world: World, _dt: number): void {
    if (world.tick % VISION_UPDATE_INTERVAL !== 1) return
    world.fog[0].beginUpdate()
    world.fog[1].beginUpdate()
    for (const id of world.entities.keys()) {
      const sight = world.sight[id]
      if (sight <= 0) continue
      // Neutral creatures (treants) reveal fog for no one.
      if (world.team[id] > 1) continue
      const team = world.team[id] as 0 | 1
      world.fog[team].reveal(world.positionX[id], world.positionZ[id], sight)
    }
    world.fog[0].endUpdate()
    world.fog[1].endUpdate()
  }
}
