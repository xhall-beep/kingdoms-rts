import type { World } from '../core/world'

export interface MovementSystem {
    step(world: World): void
}

export class MovementSystemImpl implements MovementSystem {
    step(_world: World): void {
        // Move entities using deterministic fixed-point values.
    }
}
