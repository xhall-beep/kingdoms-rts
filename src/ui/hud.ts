import type { World } from '../core/world'

export interface Hud {
    render(world: World): void
}

export class HudImpl implements Hud {
    render(_world: World): void {
        // Render deterministic HUD state from the world.
    }
}
