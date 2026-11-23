import type { System, World } from '../core/World.ts'
import { NO_TARGET, STATE_ATTACK } from '../core/World.ts'
import { WILD_GRACE_SEC } from './bells.ts'

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
      if (world.humanSeat[team] !== 1) {
        // Shipped behavior, VERBATIM — AI teams (including every farm
        // game) must see the pristine forest exactly. The softening
        // design's check-before-decay reorder is NOT behavior-neutral:
        // heat landing exactly on the threshold (450.0) decays to
        // 449.95 first and skips the spawn in the shipped code, while
        // the reordered read spawns at once — and that one-tick shift
        // cascaded into 2 diverged farm matches (variant iteration 1,
        // 2026-11-23). The reorder survives only on the human-seat
        // path below, where the grace clamp needs it.
        if (world.wildHeat[team] > 0) {
          world.wildHeat[team] = Math.max(
            0,
            world.wildHeat[team] - WILD_HEAT_DECAY_PER_SEC * dt,
          )
        }
        if (world.wildHeat[team] < WILD_HEAT_THRESHOLD) continue
        world.wildHeat[team] -= WILD_HEAT_THRESHOLD
      } else {
        // Human seat: the threshold check reads the heat BEFORE this
        // tick's decay — the grace clamp below pins a banked debt at
        // exactly the threshold, and a decay-first read would erode
        // that pinned bank by a hair (450 -> 449.95) and forgive it
        // entirely. Natural crossings overshoot by a tick of accrual
        // either way, so the reorder moves no shipped spawn by more
        // than a tick on this path.
        if (world.wildHeat[team] < WILD_HEAT_THRESHOLD) {
          if (world.wildHeat[team] > 0) {
            world.wildHeat[team] = Math.max(
              0,
              world.wildHeat[team] - WILD_HEAT_DECAY_PER_SEC * dt,
            )
          }
          continue
        }
        // Wild grace, player seats only (softening variant, 2026-11-23):
        // the forest does not answer before the Second Bell
        // (WILD_GRACE_SEC in bells.ts) for a team a human plays — the
        // persona proving showed a First-Bell treant is still an
        // executioner for soldierless boom builds. The debt is
        // deferred, not forgiven — but it is capped at exactly one
        // answer: during grace the heat is clamped at the threshold,
        // so the bell brings ONE treant, never a burst of banked
        // spawns on consecutive ticks (a 14-worker clear-cut banks
        // two or more full thresholds by 3:00 unclamped). Pure
        // function of matchTime + the seat flag.
        if (world.matchTime < WILD_GRACE_SEC) {
          if (world.wildHeat[team] > WILD_HEAT_THRESHOLD) {
            world.wildHeat[team] = WILD_HEAT_THRESHOLD
          }
          continue
        }
        world.wildHeat[team] -= WILD_HEAT_THRESHOLD
        if (world.wildHeat[team] > 0) {
          world.wildHeat[team] = Math.max(
            0,
            world.wildHeat[team] - WILD_HEAT_DECAY_PER_SEC * dt,
          )
        }
      }
      const treant = world.spawnTreant(world.wildSiteX[team], world.wildSiteZ[team])
      // Alert chip: the spawn is an EVENT for the offending team's
      // player (visual-only) — the wrath meter itself stays quiet
      // state, the chip announces. Position is the harvest site.
      world.pushAlert('treant', world.wildSiteX[team], world.wildSiteZ[team], team)
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
