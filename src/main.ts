import { OpponentAI } from './ai/opponent'
import { Engine } from './core/Engine'
import { TEAM_ENEMY, TEAM_PLAYER, type World } from './core/World'
import { InputControllerImpl } from './input/input-controller'
import { Renderer } from './render/renderer'
import { seedScenario } from './scenario'
import { setupTowerDefense, updateTowerDefense, startWaveNow, TD_MAX_WAVES, type TDState } from './modes/tower-defense.ts'
import { setupConvergenceEpisode, updateConvergenceEpisode, type ConvergenceState } from './modes/convergence-slice.ts'
import type { FactionId } from './data/factions.ts'
import './style.css'
import { CombatSystemImpl } from './systems/combat'
import { GatherSystemImpl } from './systems/gather'
import { BellSystemImpl } from './systems/bells'
import { SeasonSystemImpl } from './systems/season'
import { LivingWildSystemImpl } from './systems/living-wild.ts'
import { WarHornSystemImpl, soundWarHorn } from './systems/warhorn'
import { ShrineSystemImpl } from './systems/shrines'
import { MovementSystemImpl } from './systems/movement'
import { ProductionSystemImpl } from './systems/production'
import { cancelTrainActive, cancelTrainQueued, enqueueTrain, researchUpgrade, upgradeBuilding } from './systems/production'
import { sfx } from './ui/feedback.ts'
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
import { PvpAiGame } from './net/pvp-ai.ts'
import type { AiPracticeTier } from './net/pvp-ai.ts'
import { readFactionSetting } from './net/pvp-setup.ts'
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
  /** Mutable per-tick hook for mode-specific updates (e.g. Tower Defense). */
  tdTick: { fn: ((w: World) => void) | null }
}

export function composeGame(canvas: HTMLCanvasElement): GameComposition {
  // Mutable hook so TD mode can attach its per-tick update after the engine exists.
  const tdTick: { fn: ((w: World) => void) | null } = { fn: null }
  const engine = new Engine({
    stepHandler: () => {
      tdTick.fn?.(engine.world)
    },
  })
  const renderer = new Renderer(canvas)
  const inputController = new InputControllerImpl()
  const hud = new HudImpl()
  const systems = {
    production: new ProductionSystemImpl(),
    gather: new GatherSystemImpl(),
    livingWild: new LivingWildSystemImpl(),
    combat: new CombatSystemImpl(),
    vision: new VisionSystemImpl(),
    victory: new VictorySystemImpl(),
    bells: new BellSystemImpl(),
    season: new SeasonSystemImpl(),
    warhorn: new WarHornSystemImpl(),
    shrines: new ShrineSystemImpl(),
    opponent: new OpponentAI(TEAM_ENEMY),
    movement: new MovementSystemImpl(),
  }
  // Decisions first, steering integration last.
  engine.world.registerSystem(systems.production)
  engine.world.registerSystem(systems.gather)
  engine.world.registerSystem(systems.livingWild)
  engine.world.registerSystem(systems.combat)
  engine.world.registerSystem(systems.vision)
  engine.world.registerSystem(systems.victory)
  engine.world.registerSystem(systems.bells)
  engine.world.registerSystem(systems.season)
  engine.world.registerSystem(systems.warhorn)
  engine.world.registerSystem(systems.shrines)
  engine.world.registerSystem(systems.opponent)
  engine.world.registerSystem(systems.movement)
  inputController.attach(canvas, engine.world, renderer)
  return { engine, renderer, inputController, hud, systems, tdTick }
}

/**
 * Set up Tower Defense UI overlay: wave banner, start wave button, status.
 */
/**
 * Match-end modal: Victory/Defeat, rating change when known, rematch button.
 * Called twice: immediately (rating pending) and again once the server
 * responds with the updated rating. Idempotent — reuses the same element.
 * Practice passes hideRating: there is no server and no rating at stake,
 * so the rating line is hidden instead of pending forever.
 */
function showMatchEndModal(won: boolean, ratingBefore: number | null, ratingAfter: number | null, opponentName: string, hideRating = false): void {
  let modal = document.getElementById('pvp-end-modal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'pvp-end-modal'
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:2000;'
    modal.innerHTML = `
      <div style="background:#1a2b2b;color:#fff;padding:32px 48px;border-radius:12px;text-align:center;min-width:280px;">
        <div id="pvp-end-title" style="font-size:32px;font-weight:bold;margin-bottom:8px;"></div>
        <div id="pvp-end-sub" style="font-size:14px;opacity:0.7;margin-bottom:16px;"></div>
        <div id="pvp-end-rating" style="font-size:20px;margin-bottom:24px;"></div>
        <div>
          <button id="pvp-end-rematch" style="padding:10px 24px;font-size:16px;margin-right:8px;cursor:pointer;">Find Match</button>
          <button id="pvp-end-close" style="padding:10px 24px;font-size:16px;cursor:pointer;">Close</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    const close = () => modal!.remove()
    modal.querySelector('#pvp-end-close')!.addEventListener('click', close)
    modal.querySelector('#pvp-end-rematch')!.addEventListener('click', () => {
      close()
      // Re-open the PvP lobby queue via the HUD button
      document.querySelector<HTMLElement>('#hud-pvp')?.click()
    })
  }
  const title = modal.querySelector('#pvp-end-title')!
  const sub = modal.querySelector('#pvp-end-sub')!
  const ratingEl = modal.querySelector('#pvp-end-rating')!
  title.textContent = won ? 'Victory!' : 'Defeat'
  ;(title as HTMLElement).style.color = won ? '#f5c542' : '#e06c6c'
  sub.textContent = `vs ${opponentName}`
  if (hideRating) {
    ;(ratingEl as HTMLElement).style.display = 'none'
  } else if (ratingBefore !== null && ratingAfter !== null) {
    ;(ratingEl as HTMLElement).style.display = ''
    const delta = ratingAfter - ratingBefore
    const sign = delta >= 0 ? '+' : ''
    const color = delta >= 0 ? '#7dd87d' : '#e06c6c'
    ratingEl.innerHTML = `Rating: ${ratingBefore} → <b style="color:${color}">${ratingAfter} (${sign}${delta})</b>`
  } else {
    ;(ratingEl as HTMLElement).style.display = ''
    ratingEl.textContent = 'Updating rating…'
  }
}


function setupConvergenceUI(_state: ConvergenceState): void {
  const overlay = document.createElement('div')
  overlay.id = 'convergence-overlay'
  overlay.innerHTML = `
    <div id="conv-banner" style="position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(18,22,34,0.95);border:1px solid #aa3bff;color:#f3f4f6;padding:12px 24px;border-radius:10px;font-size:15px;z-index:1000;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,0.6);min-width:320px;max-width:90vw;">
      <div id="conv-title" style="font-size:17px;font-weight:bold;color:#f5c542;margin-bottom:4px;">⚔️ The Shattered Convergence (4 Factions)</div>
      <div id="conv-msg" style="font-size:13px;opacity:0.9;color:#38bdf8;margin-bottom:8px;">Reclaim the Central Relic and vanquish the Undead Host!</div>
      <div id="conv-objs" style="font-size:12px;opacity:0.85;display:flex;gap:16px;justify-content:center;"></div>
      <div style="margin-top:8px;">
        <button id="conv-exit" style="padding:4px 12px;font-size:12px;background:#374151;color:#fff;border:none;border-radius:4px;cursor:pointer;">Exit Episode</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const exitBtn = document.getElementById('conv-exit')
  if (exitBtn) {
    exitBtn.onclick = () => {
      localStorage.removeItem('krts-game-mode')
      location.reload()
    }
  }
}

function updateConvergenceUI(state: ConvergenceState): void {
  const msgEl = document.getElementById('conv-msg')
  const objsEl = document.getElementById('conv-objs')
  if (msgEl && state.messageBanner) {
    msgEl.textContent = state.messageBanner
  }
  if (objsEl) {
    objsEl.innerHTML = state.objectives.map(o => `<span style="color:${o.completed ? '#4ade80' : '#9ca3af'};">${o.completed ? '✓' : '○'} ${o.title}</span>`).join(' | ')
  }
}

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
  let convState: ConvergenceState | null = null
  if (gameMode === 'convergence') {
    const world = composition.engine.world
    convState = setupConvergenceEpisode(world)
    const conv = convState
    composition.tdTick.fn = (w) => {
      updateConvergenceEpisode(w, conv)
    }
    setupConvergenceUI(convState)
  } else if (gameMode === 'tower-defense') {
    // Tower Defense: no opponent AI, no standard victory check (TD has its own
    // win/lose), custom setup. TD update runs on the fixed sim tick.
    const world = composition.engine.world
    const oppIdx = world.systems.indexOf(composition.systems.opponent)
    if (oppIdx !== -1) world.systems.splice(oppIdx, 1)
    const vicIdx = world.systems.indexOf(composition.systems.victory)
    if (vicIdx !== -1) world.systems.splice(vicIdx, 1)
    // Fixed seed: TD wave spawns must be reproducible run-to-run (the seed
    // feeds only SeededRandom in spawnWave; it was Date.now() % 100000).
    tdState = setupTowerDefense(world, 20261023)
    const td = tdState
    composition.tdTick.fn = (w) => {
      updateTowerDefense(w, td)
    }
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
  composition.renderer.centerOn(-40, -40, 10)
  // Keep the canvas backing store in sync with the CSS viewport. A stale or
  // fallback size (the old code measured once and never again) desyncs the
  // renderer from pointer input: the world renders tiny and every tap
  // misroutes — the Pixel black-screen + broken-tap bug. Re-measure after
  // layout settles and on every viewport change (rotation, URL-bar show/hide).
  const fitCanvas = (): void => {
    const w = canvas.clientWidth || window.innerWidth || 1280
    const h = canvas.clientHeight || window.innerHeight || 720
    composition.renderer.resize(w, h)
  }
  fitCanvas()
  requestAnimationFrame(fitCanvas)
  let fitTimer = 0
  window.addEventListener('resize', () => {
    window.clearTimeout(fitTimer)
    fitTimer = window.setTimeout(fitCanvas, 150)
  })
  window.addEventListener('orientationchange', () => {
    window.setTimeout(fitCanvas, 300)
  })
  const hudCallbacks: HudCallbacks = {
    onMode: (mode) => composition.inputController.setMode(mode),
    onBuildType: (type) => composition.inputController.setPendingBuilding(type),
    onSelectBuilding: (kind) => composition.inputController.selectBuilding(kind),
    onSelectIdleWorkers: () => composition.inputController.selectIdleWorkers(),
    onLocateBase: () => composition.inputController.centerOnBase(),
    onStop: () => composition.inputController.stopSelected(),
    onHold: () => composition.inputController.holdSelected(),
    onGestureMode: (mode) => {
      composition.inputController.setGestureMode(mode)
      composition.hud.setGestureMode(mode)
    },
    onDeselect: () => composition.inputController.deselect(),
    onCancelMode: () => composition.inputController.cancelMode(),
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
      } else {
        // Refused (queue full at the cap of 8, unaffordable, supply):
        // audible feedback — a silent no-op reads as an ignored tap.
        sfx.error()
      }
    },
    onCancelTrain: (index) => {
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      const world = composition.engine.world
      const ok = index < 0
        ? cancelTrainActive(world, buildingId)
        : cancelTrainQueued(world, buildingId, index)
      if (ok) {
        commandLog.record({
          type: 'cancelTrain',
          step: composition.engine.getSimulationSteps(),
          buildingId,
          index,
        })
      }
    },
    onMilitia: () => {
      const mustered = composition.engine.world.ringMilitiaBell(TEAM_PLAYER)
      if (mustered > 0) {
        commandLog.record({
          type: 'militia',
          step: composition.engine.getSimulationSteps(),
          team: TEAM_PLAYER,
        })
      }
    },
    onUpgrade: () => {
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      if (upgradeBuilding(composition.engine.world, buildingId)) {
        commandLog.record({
          type: 'upgrade',
          step: composition.engine.getSimulationSteps(),
          buildingId,
        })
      }
    },
    onWarHorn: (rally) => {
      if (soundWarHorn(composition.engine.world, TEAM_PLAYER, rally)) {
        commandLog.record({
          type: 'warhorn',
          step: composition.engine.getSimulationSteps(),
          team: TEAM_PLAYER,
          rally,
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
    onPvPMatchStart: (slot, opponentName, client, opponentId, matchId, matchSecret, ratingAtStart) => {
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
        pristineSave: initialSave,
        // Each side plays the faction its player picked; the turn-0
        // handshake exchanges the pair so both phones reseed identically.
        ownFaction: readFactionSetting('krts-player-faction', 'human'),
        onMatchEnd: (won) => {
          pvpActive = false
          composition.hud.setPvpActive(false)
          refreshPauseUi()
          // Persistent profile: record the result (meta-only, never sim).
          try { recordGameResult('pvp', won) } catch { /* profile unavailable */ }
          // Report result to matchmaker for rating update, then show the
          // match-end modal with the rating change.
          const httpUrl = 'https://kingdoms-pvp.stephen-x-hall.workers.dev'
          const myId = client.playerId
          const oppId = opponentId || ''
          const winnerId = won ? myId : oppId
          const loserId = won ? oppId : myId
          const before = ratingAtStart ?? 1200
          showMatchEndModal(won, null, null, opponentName)
          if (winnerId && loserId && winnerId !== loserId && matchId && matchSecret) {
            const ctrl = new AbortController()
            const timeout = setTimeout(() => ctrl.abort(), 8000)
            fetch(`${httpUrl}/api/match/result`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: ctrl.signal,
              body: JSON.stringify({ matchId, winnerId, loserId, secret: matchSecret, forPlayer: myId }),
            })
              .then((r) => r.json() as Promise<{ accepted?: boolean; rating?: number }>)
              .then((data) => {
                clearTimeout(timeout)
                if (typeof data.rating === 'number') {
                  showMatchEndModal(won, before, data.rating, opponentName)
                }
              })
              .catch(() => { clearTimeout(timeout) /* offline — rating stays, modal already shown */ })
          }
          console.log(`Match over: ${won ? 'victory' : 'defeat'}`)
        },
      })
      pvpGame.start()
      // Store for cleanup on new game
      ;(composition as unknown as { pvpGame: PvPGame }).pvpGame = pvpGame
      composition.hud.setPvpActive(true)
    },
    onSurrender: () => {
      const c = composition as unknown as { pvpGame?: PvPGame; pvpAiGame?: PvpAiGame }
      c.pvpGame?.surrender()
      c.pvpAiGame?.surrender()
    },
    onPracticeVsAi: (tier: AiPracticeTier) => {
      console.log(`Practice vs AI starting: tier=${tier}`)
      pvpActive = true
      refreshPauseUi()
      const pvpAiGame = new PvpAiGame({
        composition,
        tier,
        pristineSave: initialSave,
        onMatchEnd: (won) => {
          pvpActive = false
          composition.hud.setPvpActive(false)
          refreshPauseUi()
          try { recordGameResult('practice', won) } catch { /* profile unavailable */ }
          showMatchEndModal(won, null, null, pvpAiGame.tierLabel, true)
          console.log(`Practice match over: ${won ? 'victory' : 'defeat'}`)
        },
      })
      pvpAiGame.start()
      ;(composition as unknown as { pvpAiGame: PvpAiGame }).pvpAiGame = pvpAiGame
      composition.hud.setPvpActive(true)
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
  // Every armed-mode change (card buttons, placement, auto-reset after an
  // order) syncs the toolbar's Cancel button through this listener.
  composition.inputController.setModeListener((mode) => composition.hud.setInputMode(mode))
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
  let skirmishResultRecorded = false
  const frame = (): void => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - lastFrame) / 1000)
    lastFrame = now
    if (replaying) replayPlayer.update(dt)
    // Record vs-AI results once per game (PvP records via onMatchEnd).
    const w = composition.engine.world
    if (!pvpActive && !replaying && !tdState && !skirmishResultRecorded && w.winner !== -1) {
      skirmishResultRecorded = true
      try { recordGameResult('skirmish', w.winner === TEAM_PLAYER) } catch { /* profile unavailable */ }
    }
    // Update building placement ghost. Validity is REAL (footprint free +
    // affordable + faction rules) — the ghost used to be hardcoded green,
    // so a doomed placement looked identical to a good one.
    const ghost = composition.inputController.getGhostPosition()
    const pending = composition.inputController.getPendingBuilding()
    if (ghost && pending) {
      composition.renderer.setGhost(pending, ghost.x, ghost.z, composition.inputController.isGhostValid(w))
    } else {
      composition.renderer.setGhost(null, 0, 0, true)
    }
    composition.renderer.render(composition.engine.world, TEAM_PLAYER, dt)
    composition.hud.update(composition.engine.world, composition.inputController.getSelected())
    // Tower Defense: banner is UI-only; sim update runs on the fixed tick.
    if (tdState) {
      ;(window as any).__gameComp = composition
      updateTDBanner()
    }
    if (convState) {
      updateConvergenceUI(convState)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return composition
}

loadSprites() // Start loading sprite assets
initializeGame()
