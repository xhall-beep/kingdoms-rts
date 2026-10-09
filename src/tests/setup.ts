/**
 * Test world setup — registers all simulation systems (no AI opponent
 * for determinism).
 */
import { World } from '../core/World.ts'
import { seedScenario } from '../scenario.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { ProductionSystemImpl } from '../systems/production.ts'

export function makeWorld(): World {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new MovementSystemImpl())
  seedScenario(world)
  return world
}

export const STEP = 1 / 60

export function stepWorld(world: World, steps: number): void {
  for (let i = 0; i < steps; i += 1) world.update(STEP)
}
