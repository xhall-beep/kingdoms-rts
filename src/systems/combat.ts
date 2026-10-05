import type { World } from '../core/world'

export interface CombatSystem {
    step(world: World): void
}

export class CombatSystemImpl implements CombatSystem {
    step(_world: World): void {
        // Resolve combat orders and damage.
    }
}
