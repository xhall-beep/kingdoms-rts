/**
 * Test world setup — registers the simulation systems in the exact order
 * production composeGame (src/main.ts) uses, so test worlds step
 * identically to local-game worlds: production, gather, Living Wild,
 * combat, vision, victory, bells, season, War Horn, shrines, movement.
 * Production also registers the opponent AI between shrines and movement;
 * the test factory stays AI-free by design — tests add their own
 * OpponentAI where they want one.
 *
 * History: this factory previously omitted WarHorn and Shrines and ran
 * gather before production. Every balance verdict measured on it was an
 * annihilation-only verdict — with no shrine system registered, Victory
 * Points could never move (shrine audit 2026-10-22). Registration here
 * must track composeGame; if the two ever diverge again, tests stop
 * measuring the shipped game.
 */
import { World } from '../core/World.ts'
import { seedScenario } from '../scenario.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { LivingWildSystemImpl } from '../systems/living-wild.ts'
import { WarHornSystemImpl } from '../systems/warhorn.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'

export function makeWorld(): World {
  const world = new World()
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new LivingWildSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new BellSystemImpl())
  world.registerSystem(new SeasonSystemImpl())
  world.registerSystem(new WarHornSystemImpl())
  world.registerSystem(new ShrineSystemImpl())
  world.registerSystem(new MovementSystemImpl())
  seedScenario(world)
  return world
}

export const STEP = 1 / 60

export function stepWorld(world: World, steps: number): void {
  for (let i = 0; i < steps; i += 1) world.update(STEP)
}
