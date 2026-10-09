import { OpponentAI } from './ai/opponent'
import { Engine } from './core/Engine'
import { TEAM_ENEMY, TEAM_PLAYER } from './core/World'
import { InputControllerImpl } from './input/input-controller'
import { Renderer } from './render/renderer'
import { seedScenario } from './scenario'
import './style.css'
import { CombatSystemImpl } from './systems/combat'
import { GatherSystemImpl } from './systems/gather'
import { MovementSystemImpl } from './systems/movement'
import { ProductionSystemImpl } from './systems/production'
import { VisionSystemImpl } from './systems/vision'
import { HudImpl } from './ui/hud'

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
    vision: VisionSystemImpl
    opponent: OpponentAI
  }
}

export function composeGame(canvas: HTMLCanvasElement): GameComposition {
  const engine = new Engine()
  const renderer = new Renderer(canvas)
  const inputController = new InputControllerImpl()
  const hud = new HudImpl()
  const systems = {
    production: new ProductionSystemImpl(),
    gather: new GatherSystemImpl(),
    combat: new CombatSystemImpl(),
    vision: new VisionSystemImpl(),
    victory: new VictorySystemImpl(),
    opponent: new OpponentAI(TEAM_ENEMY),
    movement: new MovementSystemImpl(),
  }
  // Decisions first, steering integration last.
  engine.world.registerSystem(systems.production)
  engine.world.registerSystem(systems.gather)
  engine.world.registerSystem(systems.combat)
  engine.world.registerSystem(systems.vision)
  engine.world.registerSystem(systems.victory)
  engine.world.registerSystem(systems.opponent)
  engine.world.registerSystem(systems.movement)
  inputController.attach(canvas, engine.world, renderer)
  return { engine, renderer, inputController, hud, systems }
}

export function initializeGame(): GameComposition {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) {
    throw new Error('Application root #app was not found')
  }

  app.innerHTML = `
    <main class="game-shell">
      <div id="hud-root"></div>
      <section class="game-stage" aria-label="RTS game viewport">
        <canvas id="game-canvas"></canvas>
      </section>
    </main>
  `

  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!canvas) {
    throw new Error('Game canvas was not found')
  }
  const hudRoot = document.querySelector<HTMLElement>('#hud-root')
  if (!hudRoot) {
    throw new Error('HUD root was not found')
  }

  const composition = composeGame(canvas)
  seedScenario(composition.engine.world)
  composition.renderer.centerOn(-40, -40, 8)
  composition.renderer.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720)
  const hudCallbacks: HudCallbacks = {
    onMode: (mode) => composition.inputController.setMode(mode),
    onBuildType: (type) => composition.inputController.setPendingBuilding(type),
    onTrain: (type) => {
      const selected = composition.inputController.getSelected()
      if (selected.length === 1) enqueueTrain(composition.engine.world, selected[0], type)
    },
  }
  composition.hud.mount(hudRoot, hudCallbacks)
  composition.engine.start()

  // Render loop: draw the world for the player, then refresh the HUD.
  const frame = (): void => {
    composition.renderer.render(composition.engine.world, TEAM_PLAYER)
    composition.hud.update(composition.engine.world, composition.inputController.getSelected())
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return composition
}

initializeGame()
