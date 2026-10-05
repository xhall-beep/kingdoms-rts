import type { World } from '../core/World'

export interface ProductionSystem {
    step(world: World): void
}

export class ProductionSystemImpl implements ProductionSystem {
    step(_world: World): void {
        // Produce units and structures from scheduled orders.
    }
}
