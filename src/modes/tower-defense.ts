/**
 * Tower Defense mode — survive escalating waves of enemies attacking your Town Hall.
 *
 * Inspired by Castle Keep Rush (Ludo.ai design doc): build towers, manage workers,
 * survive waves. Uses the standard Kingdoms engine/systems.
 */
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_HALL } from '../core/World.ts'
import { SeededRandom } from '../core/Math.ts'
import { orderAttackMove } from '../systems/combat.ts'

export const TD_MAX_WAVES = 10
export const TD_BUILD_PHASE_TICKS = 30 * 60 // 30 seconds between waves

export interface TDState {
  mode: 'build' | 'wave' | 'victory' | 'defeat'
  wave: number              // Current wave (1-indexed, 0 = pre-game)
  buildTicksLeft: number    // Ticks until next wave in build phase
  enemiesRemaining: number  // Enemies alive in current wave
  rng: SeededRandom
}

/** Wave composition: returns [meleeCount, rangedCount] for wave n (1-indexed). */
export function waveComposition(n: number): [number, number] {
  const melee = 2 + n * 2
  const ranged = n >= 3 ? Math.floor(n * 1.5) : 0
  return [melee, ranged]
}

export function createTDState(seed: number): TDState {
  return {
    mode: 'build',
    wave: 0,
    buildTicksLeft: TD_BUILD_PHASE_TICKS,
    enemiesRemaining: 0,
    rng: new SeededRandom(seed),
  }
}

/**
 * Set up a tower-defense game: player hall at center, workers, resources.
 * No enemy base — enemies spawn from map edges.
 */
export function setupTowerDefense(world: World, seed: number): TDState {
  // Player Town Hall at center
  world.spawnBuilding('hall', TEAM_PLAYER, 0, 0, true)

  // Starting workers
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    world.spawnUnit('worker', TEAM_PLAYER, Math.cos(angle) * 8, Math.sin(angle) * 8)
  }

  // Starting resources
  world.gold[TEAM_PLAYER] = 400
  world.wood[TEAM_PLAYER] = 300

  return createTDState(seed)
}

/** Spawn wave n enemies at map edges, ordered to attack the Town Hall. */
export function spawnWave(world: World, state: TDState): void {
  const n = state.wave
  const [meleeCount, rangedCount] = waveComposition(n)
  const rng = state.rng

  // Find the player's hall
  let hallX = 0, hallZ = 0
  for (const [id] of world.entities) {
    if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER) {
      hallX = world.positionX[id]
      hallZ = world.positionZ[id]
      break
    }
  }

  const total = meleeCount + rangedCount
  for (let i = 0; i < total; i++) {
    // Spawn at random edge
    const edge = Math.floor(rng.next() * 4)
    const offset = (rng.next() - 0.5) * 60
    let x = 0, z = 0
    const R = 45 // spawn radius
    if (edge === 0) { x = offset; z = -R }
    else if (edge === 1) { x = offset; z = R }
    else if (edge === 2) { x = -R; z = offset }
    else { x = R; z = offset }

    const type = i < meleeCount ? 'melee' : 'ranged'
    const e = world.spawnUnit(type, TEAM_ENEMY, x, z)
    // Order to attack-move toward the hall
    orderAttackMove(world, e.id, hallX, hallZ)
  }

  state.enemiesRemaining = total
  state.mode = 'wave'
}

/** Update TD state each tick. Returns events for UI. */
export function updateTowerDefense(world: World, state: TDState): string[] {
  const events: string[] = []

  if (state.mode === 'build') {
    state.buildTicksLeft--
    if (state.buildTicksLeft <= 0) {
      state.wave++
      spawnWave(world, state)
      events.push(`wave_start:${state.wave}`)
    }
  } else if (state.mode === 'wave') {
    // Count remaining enemies
    let remaining = 0
    let hallAlive = false
    for (const [id] of world.entities) {
      if (world.team[id] === TEAM_ENEMY && world.kind[id] <= 2) remaining++
      if (world.kind[id] === KIND_HALL && world.team[id] === TEAM_PLAYER) hallAlive = true
    }
    state.enemiesRemaining = remaining

    if (!hallAlive) {
      state.mode = 'defeat'
      events.push('defeat')
    } else if (remaining === 0) {
      if (state.wave >= TD_MAX_WAVES) {
        state.mode = 'victory'
        events.push('victory')
      } else {
        state.mode = 'build'
        state.buildTicksLeft = TD_BUILD_PHASE_TICKS
        events.push(`wave_cleared:${state.wave}`)
        // Bonus resources for clearing
        world.gold[TEAM_PLAYER] += 100 + state.wave * 20
        world.wood[TEAM_PLAYER] += 75 + state.wave * 15
      }
    }
  }

  return events
}

/** Skip the build phase and start the next wave immediately. */
export function startWaveNow(world: World, state: TDState): void {
  if (state.mode !== 'build') return
  state.wave++
  spawnWave(world, state)
}
