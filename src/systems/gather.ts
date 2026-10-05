import type { World } from '../core/World'

export interface GatherSystem {
    step(world: World): void
}

export class GatherSystemImpl implements GatherSystem {
    step(_world: World): void {
        // Gather resources and update production state.
    }
}
