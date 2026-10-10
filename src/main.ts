import { OpponentAI } from './ai/opponent'
import { Engine } from './core/Engine'
import { TEAM_ENEMY, TEAM_PLAYER } from './core/World'
import { InputControllerImpl } from './input/input-controller'
import { Renderer } from './render/renderer'
import { seedScenario } from './scenario'
import type { FactionId } from './data/factions.ts'
import './style.css'
import { CombatSystemImpl } from './systems/combat'
import { GatherSystemImpl } from './systems/gather'
import { MovementSystemImpl } from './systems/movement'
import { ProductionSystemImpl } from './systems/production'
import { enqueueTrain } from './systems/production'
import { VictorySystemImpl } from './systems/victory'
import { VisionSystemImpl } from './systems/vision'
import { CommandLog } from './session/commands.ts'
import { ReplayPlayer } from './session/replay.ts'
import {
  deserializeWorld,
  loadIntoWorld,
  clearSave,
  readSave,
  serializeWorld,
  writeSave,
} from './session/save-load.ts'
import type { AIDifficulty } from './ai/opponent'
import { HudImpl } from './ui/hud'
import type { HudCallbacks } from './ui/hud'

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
    victory: VictorySystemImpl
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
  const playerFaction = (localStorage.getItem('krts-player-faction') || 'human') as FactionId
  const enemyFaction = (localStorage.getItem('krts-enemy-faction') || 'orc') as FactionId
  seedScenario(composition.engine.world, playerFaction, enemyFaction)
  const commandLog = new CommandLog()
  composition.inputController.setCommandListener((cmd) => {
    commandLog.record({ ...cmd, step: composition.engine.getSimulationSteps() })
  })
  // Pristine initial state for replays; live state stashed when entering replay.
  const initialSave = serializeWorld(composition.engine.world, 0, [])
  let liveSave: ReturnType<typeof serializeWorld> | null = null
  let replaying = false
  const replayPlayer = new ReplayPlayer(composition.engine.world)
  composition.renderer.centerOn(-40, -40, 8)
  composition.renderer.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720)
  const hudCallbacks: HudCallbacks = {
    onMode: (mode) => composition.inputController.setMode(mode),
    onBuildType: (type) => composition.inputController.setPendingBuilding(type),
    onSelectBuilding: (kind) => composition.inputController.selectBuilding(kind),
    onSelectIdleWorkers: () => composition.inputController.selectIdleWorkers(),
    onStop: () => composition.inputController.stopSelected(),
    onTrain: (type) => {
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      if (enqueueTrain(composition.engine.world, buildingId, type)) {
        commandLog.record({
          type: 'train',
          step: composition.engine.getSimulationSteps(),
          buildingId,
          unit: type,
        })
      }
    },
    onPause: () => {
      const engine = composition.engine
      if (engine.isPaused()) engine.resume()
      else engine.pause()
    },
    onSave: () => {
      writeSave(
        composition.engine.world,
        composition.engine.getSimulationSteps(),
        commandLog.getCommands(),
      )
    },
    onDifficulty: (d: AIDifficulty) => {
      const world = composition.engine.world
      const systems = composition.systems
      const idx = world.systems.indexOf(systems.opponent)
      const next = new OpponentAI(TEAM_ENEMY, d)
      if (idx !== -1) world.systems.splice(idx, 1, next)
      else world.systems.push(next)
      systems.opponent = next
    },
    onReplay: () => {
      const world = composition.engine.world
      if (!replaying) {
        // Enter replay: stash live game, rewind, play back commands.
        liveSave = serializeWorld(world, composition.engine.getSimulationSteps(), commandLog.getCommands())
        deserializeWorld(world, initialSave)
        replayPlayer.load(commandLog.getCommands())
        composition.engine.pause()
        replaying = true
      } else {
        // Exit replay: restore the live game.
        if (liveSave) deserializeWorld(world, liveSave)
        commandLog.fromJSON(liveSave ? liveSave.commands : [])
        composition.engine.resume()
        replaying = false
      }
    },
    onReplaySpeed: (speed: number) => {
      replayPlayer.setSpeed(speed)
    },
    onNewGame: () => {
      clearSave()
      location.reload()
    },
    onLoad: () => {
      const save = readSave()
      if (!save) return
      const { commands } = loadIntoWorld(composition.engine.world, save)
      commandLog.fromJSON(commands)
      composition.inputController.setCommandListener((cmd) => {
        commandLog.record({ ...cmd, step: composition.engine.getSimulationSteps() })
      })
    },
  }
  composition.hud.mount(hudRoot, hudCallbacks)
  composition.engine.start()

  // Autosave every 30 seconds so a closed tab never loses much.
  setInterval(() => {
    if (composition.engine.world.winner === -1) {
      writeSave(
        composition.engine.world,
        composition.engine.getSimulationSteps(),
        commandLog.getCommands(),
      )
    }
  }, 30_000)

  // Render loop: draw the world for the player, then refresh the HUD.
  let lastFrame = performance.now()
  const frame = (): void => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - lastFrame) / 1000)
    lastFrame = now
    if (replaying) replayPlayer.update(dt)
    // Update building placement ghost.
    const ghost = composition.inputController.getGhostPosition()
    const pending = composition.inputController.getPendingBuilding()
    if (ghost && pending) {
      composition.renderer.setGhost(pending, ghost.x, ghost.z, true)
    } else {
      composition.renderer.setGhost(null, 0, 0, true)
    }
    composition.renderer.render(composition.engine.world, TEAM_PLAYER)
    composition.hud.update(composition.engine.world, composition.inputController.getSelected())
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return composition
}

initializeGame()
