import type { System, World } from '../core/World.ts'
import { NO_TARGET, STATE_ATTACK } from '../core/World.ts'

/**
 * The Living Wild (v2.0 canon): over-harvest spawns hostile treants.
 *
 * Every swing that tears wood from a tree feeds the harvesting team's
 * wild heat. Heat decays steadily, so an ordinary wood line — a handful
 * of workers — never accumulates: measured on the seeded scenario, a
 * 4-worker economy extracts ~1.3 wood/s from trees, under the 3 wood/s
 * the decay sheds. A grown 9-worker economy peaks near 8.5 wood/s in
 * its opening minutes and now answers for cutting sustained at that
 * pace; a deliberate clear-cut (10+ workers on wood) sustains 8–15
 * wood/s and crosses the threshold in about a minute. Elven
 * sap-tapping is symbiotic and feeds no heat (the gather system does
 * not call recordTreeHarvest for it).
 *
 * Tuning (2026-10-23, Balance Report recommendation): at the original
 * 600 heat / 4-per-second decay the forest almost never answered in AI
 * games (1 treant across a 36-match series), so the threshold dropped
 * to 450 and the decay to 3/s — small wood lines stay beneath notice,
 * grown economies and clear-cuts draw the forest's answer.
 *
 * When heat crosses the threshold, the forest answers: a treant rises
 * at the most recent harvest site and hunts the worker who cut there.
 * The trigger consumes the threshold, so continued clear-cutting earns
 * another treant, renewed pressure for renewed greed.
 *
 * Everything here is a pure function of sim state: heat, site and
 * offender are hashed and saved like the other match-meta fields, the
 * spawn uses the ordinary deterministic entity allocation, and no RNG
 * is involved at all.
 */

/** Wood-from-trees pressure at which the forest retaliates. */
export const WILD_HEAT_THRESHOLD = 450
/** Heat shed per second while a team leaves the forest alone. */
export const WILD_HEAT_DECAY_PER_SEC = 3

/**
 * Record one swing's worth of wood torn from a tree. Called by the
 * gather system for real (depleting) harvests only — never for elven
 * sap-taps, which take without wounding.
 */
export function recordTreeHarvest(
  world: World,
  team: 0 | 1,
  taken: number,
  nodeId: number,
  workerId: number,
): void {
  world.wildHeat[team] += taken
  world.wildSiteX[team] = world.positionX[nodeId]
  world.wildSiteZ[team] = world.positionZ[nodeId]
  world.wildWorker[team] = workerId
}

export class LivingWildSystemImpl implements System {
  update(world: World, dt: number): void {
    for (const team of [0, 1] as const) {
      if (world.wildHeat[team] > 0) {
        world.wildHeat[team] = Math.max(
          0,
          world.wildHeat[team] - WILD_HEAT_DECAY_PER_SEC * dt,
        )
      }
      if (world.wildHeat[team] < WILD_HEAT_THRESHOLD) continue
      world.wildHeat[team] -= WILD_HEAT_THRESHOLD
      const treant = world.spawnTreant(world.wildSiteX[team], world.wildSiteZ[team])
      // First blood: the worker who was cutting at the site, if it still
      // stands. Otherwise the treant acquires by sight like any creature.
      const offender = world.wildWorker[team]
      if (
        offender !== NO_TARGET &&
        world.entities.has(offender) &&
        world.team[offender] === team
      ) {
        world.targetId[treant.id] = offender
        world.state[treant.id] = STATE_ATTACK
      }
    }
  }
}
