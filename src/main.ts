import { OpponentAI } from './ai/opponent'
import { Engine } from './core/Engine'
import { TEAM_ENEMY, TEAM_PLAYER } from './core/World'
import { InputControllerImpl } from './input/input-controller'
import { Renderer } from './render/renderer'
import { seedScenario } from './scenario'
import { setupTowerDefense, updateTowerDefense, startWaveNow, TD_MAX_WAVES, type TDState } from './modes/tower-defense.ts'
import type { FactionId } from './data/factions.ts'
import './style.css'
import { CombatSystemImpl } from './systems/combat'
import { GatherSystemImpl } from './systems/gather'
import { MovementSystemImpl } from './systems/movement'
import { ProductionSystemImpl } from './systems/production'
import { enqueueTrain, researchUpgrade } from './systems/production'
import type { UpgradeType } from './data/upgrades.ts'
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
import type { AIDifficulty, AIPersonality } from './ai/opponent'
import { HudImpl } from './ui/hud'
import { PvPGame } from './net/pvp-game.ts'
import { loadSprites } from './render/sprites.ts'
import type { HudCallbacks } from './ui/hud'
import { ensureProfile, initProfileUi, recordGameResult } from './ui/profile-panel.ts'
import { initPauseUi, refreshPauseUi, requestPause, requestResume } from './ui/pause-overlay.ts'
import {
  saveCampaignSave,
  loadCampaignSave,
  clearCampaignSave,
  hasCampaignSave,
} from './profile/campaign-save.ts'

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

/**
 * Set up Tower Defense UI overlay: wave banner, start wave button, status.
 */
function setupTDUI(tdState: TDState): void {
  const overlay = document.createElement('div')
  overlay.id = 'td-overlay'
  overlay.innerHTML = `
    <div id="td-banner" style="position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:white;padding:10px 20px;border-radius:8px;font-size:18px;z-index:1000;text-align:center;">
      <div id="td-wave-text">Prepare your defenses!</div>
      <div id="td-status-text" style="font-size:14px;opacity:0.8;"></div>
      <button id="td-start-wave" style="margin-top:8px;padding:8px 16px;font-size:16px;cursor:pointer;">Start Wave 1</button>
      <button id="td-exit" style="margin-top:8px;margin-left:8px;padding:8px 16px;font-size:14px;cursor:pointer;">Exit TD</button>
    </div>
  `
  document.body.appendChild(overlay)

  const startBtn = document.getElementById('td-start-wave') as HTMLButtonElement
  const exitBtn = document.getElementById('td-exit') as HTMLButtonElement
  const waveText = document.getElementById('td-wave-text')!
  const statusText = document.getElementById('td-status-text')!

  // Store references for update loop
  ;(window as any).__tdUI = { waveText, statusText, startBtn, tdState }

  startBtn.onclick = () => {
    const comp = (window as any).__gameComp
    if (comp && tdState.mode === 'build') {
      startWaveNow(comp.engine.world, tdState)
      updateTDBanner()
    }
  }
  exitBtn.onclick = () => {
    localStorage.removeItem('krts-game-mode')
    location.reload()
  }
}

/** Update the TD banner from current state. Called each frame. */
function updateTDBanner(): void {
  const ui = (window as any).__tdUI
  if (!ui) return
  const { waveText, statusText, startBtn, tdState } = ui
  if (tdState.mode === 'build') {
    const secs = Math.ceil(tdState.buildTicksLeft / 60)
    waveText.textContent = tdState.wave === 0 ? 'Prepare your defenses!' : `Wave ${tdState.wave} cleared!`
    statusText.textContent = `Next wave in ${secs}s — Wave ${tdState.wave + 1} of ${TD_MAX_WAVES}`
    startBtn.style.display = ''
    startBtn.textContent = `Start Wave ${tdState.wave + 1}`
  } else if (tdState.mode === 'wave') {
    waveText.textContent = `Wave ${tdState.wave} of ${TD_MAX_WAVES}`
    statusText.textContent = `Enemies remaining: ${tdState.enemiesRemaining}`
    startBtn.style.display = 'none'
  } else if (tdState.mode === 'victory') {
    waveText.textContent = 'Victory! All waves survived!'
    statusText.textContent = ''
    startBtn.style.display = 'none'
  } else if (tdState.mode === 'defeat') {
    waveText.textContent = 'Defeat — your Town Hall has fallen'
    statusText.textContent = `Survived ${tdState.wave} of ${TD_MAX_WAVES} waves`
    startBtn.style.display = 'none'
  }
}

export function initializeGame(): GameComposition {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) {
    throw new Error('Application root #app was not found')
  }

  // Persistent kingdom profile (first run prompts for a kingdom name).
  ensureProfile()
  initProfileUi()

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
  // AI settings: persisted difficulty + personality, applied from the start.
  let aiDifficulty = (localStorage.getItem('krts-ai-difficulty') || 'normal') as AIDifficulty
  let aiPersonality = (localStorage.getItem('krts-ai-personality') || 'expander') as AIPersonality
  const swapOpponent = (d: AIDifficulty, p: AIPersonality): void => {
    const world = composition.engine.world
    const idx = world.systems.indexOf(composition.systems.opponent)
    const next = new OpponentAI(TEAM_ENEMY, d, p)
    if (idx !== -1) world.systems.splice(idx, 1, next)
    else world.systems.push(next)
    composition.systems.opponent = next
  }
  swapOpponent(aiDifficulty, aiPersonality)
  const playerFaction = (localStorage.getItem('krts-player-faction') || 'human') as FactionId
  const enemyFaction = (localStorage.getItem('krts-enemy-faction') || 'orc') as FactionId
  const gameMode = localStorage.getItem('krts-game-mode') || 'rts'
  let tdState: TDState | null = null
  if (gameMode === 'tower-defense') {
    // Tower Defense: no opponent AI, custom setup
    const world = composition.engine.world
    const idx = world.systems.indexOf(composition.systems.opponent)
    if (idx !== -1) world.systems.splice(idx, 1)
    tdState = setupTowerDefense(world, Date.now() % 100000)
    setupTDUI(tdState)
  } else {
    seedScenario(composition.engine.world, playerFaction, enemyFaction)
  }
  const commandLog = new CommandLog()
  composition.inputController.setCommandListener((cmd) => {
    commandLog.record({ ...cmd, step: composition.engine.getSimulationSteps() })
  })
  // Pristine initial state for replays; live state stashed when entering replay.
  const initialSave = serializeWorld(composition.engine.world, 0, [])
  let liveSave: ReturnType<typeof serializeWorld> | null = null
  let replaying = false
  let pvpActive = false
  const replayPlayer = new ReplayPlayer(composition.engine.world)
  composition.renderer.centerOn(-40, -40, 8)
  composition.renderer.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720)
  const hudCallbacks: HudCallbacks = {
    onMode: (mode) => composition.inputController.setMode(mode),
    onBuildType: (type) => composition.inputController.setPendingBuilding(type),
    onSelectBuilding: (kind) => composition.inputController.selectBuilding(kind),
    onSelectIdleWorkers: () => composition.inputController.selectIdleWorkers(),
    onStop: () => composition.inputController.stopSelected(),
    onHold: () => composition.inputController.holdSelected(),
    onResearch: (type) => {
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      researchUpgrade(composition.engine.world, buildingId, type as UpgradeType)
    },
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
      // Gated: no-op in PvP (lockstep must never pause).
      if (composition.engine.isPaused()) requestResume()
      else requestPause()
    },
    onSave: () => {
      writeSave(
        composition.engine.world,
        composition.engine.getSimulationSteps(),
        commandLog.getCommands(),
      )
    },
    onDifficulty: (d: AIDifficulty) => {
      aiDifficulty = d
      localStorage.setItem('krts-ai-difficulty', d)
      swapOpponent(aiDifficulty, aiPersonality)
    },
    onPersonality: (p: AIPersonality) => {
      aiPersonality = p
      localStorage.setItem('krts-ai-personality', p)
      swapOpponent(aiDifficulty, aiPersonality)
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
    onPvPMatchStart: (slot, opponentName, client, opponentId) => {
      if (!client) {
        console.error('PvP match started without a client')
        return
      }
      console.log(`PvP match starting: slot=${slot}, opponent=${opponentName}`)
      pvpActive = true
      refreshPauseUi()
      const pvpGame = new PvPGame({
        composition,
        client,
        slot,
        onMatchEnd: (won) => {
          pvpActive = false
          refreshPauseUi()
          // Persistent profile: record the result (meta-only, never sim).
          try { recordGameResult('pvp', won) } catch { /* profile unavailable */ }
          // Report result to matchmaker for rating update (fire-and-forget)
          const httpUrl = 'https://kingdoms-pvp.stephen-x-hall.workers.dev'
          const myId = client.playerId
          const oppId = opponentId || ''
          const winnerId = won ? myId : oppId
          const loserId = won ? oppId : myId
          if (winnerId && loserId && winnerId !== loserId) {
            fetch(`${httpUrl}/api/match/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ winnerId, loserId }),
            }).catch(() => { /* offline or server unreachable — rating stays */ })
          }
          // TODO: show match-end UI with rating change
          console.log(`Match over: ${won ? 'victory' : 'defeat'}`)
        },
      })
      pvpGame.start()
      // Store for cleanup on new game
      ;(composition as unknown as { pvpGame: PvPGame }).pvpGame = pvpGame
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

  // Pause overlay: single-player/campaign only — never PvP (lockstep).
  initPauseUi({
    canPause: () => !pvpActive,
    pause: () => composition.engine.pause(),
    resume: () => composition.engine.resume(),
    isPaused: () => composition.engine.isPaused(),
    saveAndQuit: () => {
      const world = composition.engine.world
      saveCampaignSave({
        mode: gameMode,
        mission: null,
        snapshot: JSON.stringify(
          serializeWorld(world, composition.engine.getSimulationSteps(), commandLog.getCommands()),
        ),
      })
      location.reload()
    },
  })

  // "Continue" for a Save & Quit campaign snapshot (one-shot).
  if (hasCampaignSave()) {
    const menu = document.querySelector<HTMLElement>('#hud-menu')
    if (menu) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'hud-pill hud-mode'
      btn.textContent = 'Continue'
      btn.addEventListener('click', () => {
        const save = loadCampaignSave()
        if (save) {
          const { commands } = loadIntoWorld(
            composition.engine.world,
            JSON.parse(save.snapshot) as Parameters<typeof loadIntoWorld>[1],
          )
          commandLog.fromJSON(commands)
          clearCampaignSave()
          btn.remove()
          menu.hidden = true
        }
      })
      menu.prepend(btn)
    }
  }

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
    // Tower Defense: update wave state and banner
    if (tdState) {
      ;(window as any).__gameComp = composition
      updateTowerDefense(composition.engine.world, tdState)
      updateTDBanner()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return composition
}

loadSprites() // Start loading sprite assets
initializeGame()
