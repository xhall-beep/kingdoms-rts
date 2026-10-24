import type { System, World } from '../core/World.ts'
import { KIND_SHRINE, KIND_MELEE, KIND_RANGED, KIND_WORKER } from '../core/World.ts'

/**
 * Shrines & Victory Points (v2.0 spec, section 4: anti-stall).
 *
 * A shrine is a neutral capturable objective. When exactly one team holds
 * military presence within the capture radius, that team holds the shrine.
 * The claim is sticky — contested or empty keeps the holder — but the
 * Victory Point drain is NOT: every second, a held shrine drains 5 VP
 * from the enemy only while the holder keeps at least one living unit
 * inside the capture radius. Abandon the point and the bleeding stops
 * until you return; kill the holding unit and the claim sits empty and
 * harmless until someone reoccupies it. A team reduced to 0 VP loses —
 * turtling forever is not an option, and neither is winning by a
 * momentary touch in the opening seconds.
 *
 * Capture checks run once per second (not per tick): presence barely moves
 * at 60Hz, and the sweep is O(shrines x units).
 */
export const CAPTURE_RADIUS = 8
const VP_DRAIN_PER_SHRINE = 5
const CHECK_INTERVAL = 1

function isMilitary(world: World, id: number): boolean {
  const k = world.kind[id]
  return k === KIND_MELEE || k === KIND_RANGED || k === KIND_WORKER
}

export class ShrineSystemImpl implements System {
  private timer = 0

  /**
   * Internal check timer is sim state (lockstep snapshot/hash), carried
   * exactly like the victory check timer: a rejoin that lands on a
   * different check phase would fire capture/drain on different ticks.
   * It is a float accumulator (reset to exactly 0 on each check, and
   * reset independently of world.tick by the PvP reset path), so its
   * value is NOT derivable from world.tick — it must be carried.
   */
  getTimer(): number {
    return this.timer
  }

  setTimer(t: number): void {
    this.timer = t
  }

  /**
   * Reset the internal check accumulator. It drives when shrine capture and
   * Victory Point drain tick, so a stale pre-match value would desync peers;
   * reset alongside the world when a match (re)starts from a clean state.
   */
  resetTimer(): void {
    this.timer = 0
  }

  update(world: World, dt: number): void {
    if (world.winner !== -1) return
    this.timer += dt
    if (this.timer < CHECK_INTERVAL) return
    this.timer = 0

    for (const sid of world.entities.keys()) {
      if (world.kind[sid] !== KIND_SHRINE) continue
      // Count military presence per team within the capture radius.
      let p0 = 0
      let p1 = 0
      const sx = world.positionX[sid]
      const sz = world.positionZ[sid]
      for (const id of world.entities.keys()) {
        if (!isMilitary(world, id) || world.health[id] <= 0) continue
        const dx = world.positionX[id] - sx
        const dz = world.positionZ[id] - sz
        if (dx * dx + dz * dz > CAPTURE_RADIUS * CAPTURE_RADIUS) continue
        if (world.team[id] === 0) p0 += 1
        else p1 += 1
      }
      if (p0 > 0 && p1 === 0) world.shrineHeld[sid] = 0
      else if (p1 > 0 && p0 === 0) world.shrineHeld[sid] = 1
      // Contested or empty: the holder keeps it (no flip-flopping).

      // Drain the enemy's Victory Points — but only while the holder
      // keeps a living unit inside the radius. Presence is the upkeep:
      // an empty claim bleeds nothing, so the shrine stays a genuinely
      // contested point for the whole match instead of a first-touch
      // time bomb.
      const holder = world.shrineHeld[sid]
      if (holder === 0 || holder === 1) {
        const holderPresence = holder === 0 ? p0 : p1
        if (holderPresence > 0) {
          const enemy = (1 - holder) as 0 | 1
          world.victoryPoints[enemy] = Math.max(0, world.victoryPoints[enemy] - VP_DRAIN_PER_SHRINE)
        }
      }
    }
  }

  reset(): void {
    this.timer = 0
  }
}
