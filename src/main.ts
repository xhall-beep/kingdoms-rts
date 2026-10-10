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
import type { AIDifficulty } from './ai/opponent'
import { HudImpl } from './ui/hud'
import type { HudCallbacks } from './ui/hud'
import { MatchmakingUI } from './ui/matchmaking.ts'
import { PvPClient, getPlayerId } from './net/client.ts'
import { PvPSession, WsLink } from './net/pvp-session.ts'
import { encodeMessage } from './net/protocol.ts'
import { World } from './core/World.ts'
import type { Command } from './session/commands.ts'

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

/** Live PvP server (wss; the client derives https for room creation). */
export const PVP_SERVER_URL = 'wss://kingdoms-pvp.stephen-x-hall.workers.dev'

/** PvP factions: slot 0 plays human, slot 1 plays orc (the tested balanced pair). */
export const PVP_FACTIONS = ['human', 'orc'] as const

interface PvPState {
  session: PvPSession
  client: PvPClient
  link: WsLink
  slot: 0 | 1
  engine: Engine
  opponentName: string
}

/** Non-null while a live 1v1 is running. */
let pvpState: PvPState | null = null
/** Set by startPvPMatch so incoming bundles reach the lockstep peer. */
let pvpLink: WsLink | null = null

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
    onHold: () => composition.inputController.holdSelected(),
    onTrain: (type) => {
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      if (pvpState) {
        // Lockstep PvP: training goes through the turn queue, not the local world.
        const cmd: Command = {
          type: 'train',
          step: 0,
          buildingId,
          unit: type,
        }
        pvpState.session.queueCommand(cmd)
        return
      }
      if (enqueueTrain(composition.engine.world, buildingId, type)) {
        commandLog.record({
          type: 'train',
          step: composition.engine.getSimulationSteps(),
          buildingId,
          unit: type,
        })
      }
    },
    onResearch: (type) => {
      // Research upgrades are single-player only: they are not network commands,
      // so applying them in PvP would desync the two simulations.
      if (pvpState) return
      const selected = composition.inputController.getSelected()
      if (selected.length !== 1) return
      const buildingId = selected[0]
      researchUpgrade(composition.engine.world, buildingId, type as UpgradeType)
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
    onPvP: () => {
      if (pvpState) return // already in a live match
      matchmaking.show()
      matchmaking.showMenu()
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

  // Matchmaking overlay (hidden until the PvP button is tapped).
  const matchmaking = new MatchmakingUI()
  matchmaking.mount(hudRoot, {
    onFindMatch: (name) => void findMatch(matchmaking, composition, name),
    onJoinRoom: (name, code) => joinRoom(matchmaking, composition, name, code),
    onCancel: () => {
      pvpLink = null
      activeClient?.disconnect()
      activeClient = null
      matchmaking.showMenu()
    },
    onClose: () => matchmaking.hide(),
  })

  // Autosave every 30 seconds so a closed tab never loses much.
  // Cleared when a live PvP match starts (the SP world is retired).
  const autosaveId = setInterval(() => {
    if (pvpState) return
    if (composition.engine.world.winner === -1) {
      writeSave(
        composition.engine.world,
        composition.engine.getSimulationSteps(),
        commandLog.getCommands(),
      )
    }
  }, 30_000)
  void autosaveId

  // Render loop: draw the world for the player, then refresh the HUD.
  let lastFrame = performance.now()
  const frame = (): void => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - lastFrame) / 1000)
    lastFrame = now
    const world = pvpState ? pvpState.engine.world : composition.engine.world
    const viewTeam = pvpState ? pvpState.slot : TEAM_PLAYER
    if (pvpState) {
      // Lockstep drives the sim in PvP: pump before rendering.
      pvpState.session.pump(now)
    } else if (replaying) {
      replayPlayer.update(dt)
    }
    // Update building placement ghost.
    const ghost = composition.inputController.getGhostPosition()
    const pending = composition.inputController.getPendingBuilding()
    if (ghost && pending) {
      composition.renderer.setGhost(pending, ghost.x, ghost.z, true)
    } else {
      composition.renderer.setGhost(null, 0, 0, true)
    }
    composition.renderer.render(world, viewTeam)
    composition.hud.update(world, composition.inputController.getSelected())
    // PvP stall indicator: "waiting for opponent" when the peer starves.
    if (pvpState) updatePvPStatus()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return composition
}

/** The live client for the current matchmaking attempt (null when idle). */
let activeClient: PvPClient | null = null

/** Create a room and wait for an opponent. */
async function findMatch(
  mm: MatchmakingUI,
  composition: GameComposition,
  name: string,
): Promise<void> {
  mm.showCreating()
  try {
    const code = await PvPClient.createRoom(PVP_SERVER_URL)
    joinRoom(mm, composition, name, code, true)
  } catch {
    mm.showError('Could not create a room. Check your connection and try again.')
  }
}

/** Join a room by code (or the code we just created). */
function joinRoom(
  mm: MatchmakingUI,
  composition: GameComposition,
  name: string,
  code: string,
  isHost = false,
): void {
  const clean = code.trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(clean)) {
    mm.showError("That code doesn't look right — it should be 6 characters.")
    return
  }
  activeClient?.disconnect()
  pvpLink = null
  let slot: 0 | 1 | null = null
  const client = new PvPClient({
    serverUrl: PVP_SERVER_URL,
    playerId: getPlayerId(),
    playerName: name,
    onAssigned: (s) => {
      slot = s
    },
    onMatchStart: (players) => {
      if (slot === null) return
      const opponent = players.find((pl) => pl.slot !== slot)
      startPvPMatch(mm, composition, client, slot, opponent?.name ?? 'Opponent')
    },
    onTurnBundle: (bundle) => pvpLink?.receive(encodeMessage(bundle)),
    onHash: (msg) => pvpLink?.receive(encodeMessage(msg)),
    onOpponentDisconnected: () => handleOpponentDisconnect(mm),
    onPlayerJoined: (count) => mm.setPlayerCount(count),
  })
  activeClient = client
  if (isHost) mm.showWaiting(clean)
  else mm.showJoining(clean)
  client.connect(clean)
}

/**
 * Both players are in: retire the single-player game and start the
 * deterministic lockstep 1v1. Slot 0 plays human, slot 1 plays orc.
 */
function startPvPMatch(
  mm: MatchmakingUI,
  composition: GameComposition,
  client: PvPClient,
  slot: 0 | 1,
  opponentName: string,
): void {
  mm.hide()
  // Retire single-player: stop its loop (autosave checks pvpState and skips).
  composition.engine.stop()

  // Fresh deterministic world for the 1v1.
  const world = new World()
  seedScenario(world, PVP_FACTIONS[0], PVP_FACTIONS[1])
  const engine = new Engine({ world })
  // Every system except the AI opponent — both teams are human.
  engine.world.registerSystem(new ProductionSystemImpl())
  engine.world.registerSystem(new GatherSystemImpl())
  engine.world.registerSystem(new CombatSystemImpl())
  engine.world.registerSystem(new VisionSystemImpl())
  engine.world.registerSystem(new VictorySystemImpl())
  engine.world.registerSystem(new MovementSystemImpl())

  // Input now goes through the lockstep queue; enemy checks use our slot.
  const ic = composition.inputController
  ic.setWorld(world)
  ic.setLocalTeam(slot)
  ic.setDeferredExecution(true)

  composition.hud.setLocalTeam(slot)
  // Center the camera on our base.
  composition.renderer.centerOn(slot === 0 ? -40 : 40, slot === 0 ? -40 : 40, 8)

  const link = new WsLink((kind, data) => client.sendRaw(kind, data))
  pvpLink = link
  const session = new PvPSession(slot, world, link, {
    onStall: () => {
      // The frame loop shows the stall pill (see updatePvPStatus).
    },
    onDesync: (turn) => {
      // Should not happen with identical seeds + inputs; log for diagnosis.
      console.warn(`[pvp] desync detected at turn ${turn}`)
    },
  })
  ic.setCommandListener((cmd) => session.queueCommand(cmd))

  pvpState = { session, client, link, slot, engine, opponentName }
}

/** Stall-pill bookkeeping for updatePvPStatus (module state, no namespace). */
const pvpStallState = { lastTurn: -1, lastAdvance: 0 }

/** Show a "waiting for opponent" pill while the lockstep peer starves. */
let stallPill: HTMLElement | null = null
function updatePvPStatus(): void {
  const hudRoot = document.querySelector('#hud-root')
  if (!hudRoot) return
  if (!stallPill) {
    stallPill = document.createElement('div')
    stallPill.className = 'hud-pill hud-pvp-stall'
    stallPill.textContent = '⏳ Waiting for opponent…'
    stallPill.hidden = true
    hudRoot.appendChild(stallPill)
  }
  // Cheap stall signal: our turn hasn't advanced in a while.
  const turn = pvpState?.session.currentTurn ?? 0
  const starved =
    turn === pvpStallState.lastTurn && performance.now() - pvpStallState.lastAdvance > 3000
  if (turn !== pvpStallState.lastTurn) {
    pvpStallState.lastTurn = turn
    pvpStallState.lastAdvance = performance.now()
  }
  stallPill.hidden = !starved || !pvpState
}

/** The other side left. Offer rematch or a clean exit. */
function handleOpponentDisconnect(mm: MatchmakingUI): void {
  if (!pvpState) {
    // Left while waiting: just refresh the count display.
    mm.setPlayerCount(1)
    return
  }
  const st = pvpState
  st.client.disconnect()
  pvpLink = null
  activeClient = null
  pvpState = null
  if (stallPill) stallPill.hidden = true
  pvpStallState.lastTurn = -1
  pvpStallState.lastAdvance = 0
  mm.show()
  mm.showDisconnected(
    () => {
      // Rematch: fresh room, same name.
      mm.showMenu()
    },
    () => {
      // Back to single-player.
      location.reload()
    },
  )
  void st
}

initializeGame()
