import './style.css'
import { Engine } from './core/engine'
import { Renderer } from './render/renderer'
import { InputControllerImpl } from './input/input-controller'
import { HudImpl } from './ui/hud'
import { CombatSystemImpl } from './systems/combat'
import { GatherSystemImpl } from './systems/gather'
import { MovementSystemImpl } from './systems/movement'
import { ProductionSystemImpl } from './systems/production'

export interface GameComposition {
  engine: Engine
  renderer: Renderer
  inputController: InputControllerImpl
  hud: HudImpl
  systems: {
    movement: MovementSystemImpl
    combat: CombatSystemImpl
    gather: GatherSystemImpl
    production: ProductionSystemImpl
  }
}

export function composeGame(): GameComposition {
  return {
    engine: new Engine(),
    renderer: new Renderer({ width: 1280, height: 720 }),
    inputController: new InputControllerImpl(),
    hud: new HudImpl(),
    systems: {
      movement: new MovementSystemImpl(),
      combat: new CombatSystemImpl(),
      gather: new GatherSystemImpl(),
      production: new ProductionSystemImpl(),
    },
  }
}

export function initializeGame(): GameComposition {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) {
    throw new Error('Application root #app was not found')
  }

  const composition = composeGame()
  app.innerHTML = `
    <main class="game-shell">
      <header class="game-header">
        <h1>Kingdoms RTS</h1>
        <p>Deterministic ECS composition root</p>
      </header>
      <section class="game-stage" aria-label="RTS game viewport">
        <canvas id="game-canvas"></canvas>
      </section>
    </main>
  `

  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!canvas) {
    throw new Error('Game canvas was not found')
  }

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('2D canvas context is unavailable')
  }

  composition.renderer.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720)
  composition.hud.render(composition.engine.world)
  composition.engine.start()
  return composition
}

initializeGame()
