/**
 * Headless AI vs AI match runner — automated balance and stability testing.
 * Runs full games without rendering to validate game balance, AI behavior,
 * and long-term stability.
 */
import { World } from '../core/World.ts'
import { seedScenario } from '../scenario.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { OpponentAI, type AIDifficulty } from '../ai/opponent.ts'
import { STEP } from './setup.ts'

export interface MatchResult {
  winner: number
  steps: number
  durationSeconds: number
  playerUnits: number
  enemyUnits: number
  playerBuildings: number
  enemyBuildings: number
}

export function runMatch(
  playerDifficulty: AIDifficulty = 'normal',
  enemyDifficulty: AIDifficulty = 'normal',
  maxSteps = 60 * 60 * 20, // 20 minutes max
): MatchResult {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new MovementSystemImpl())
  // AI for both teams (player team AI simulates a player).
  world.registerSystem(new OpponentAI(0, playerDifficulty))
  world.registerSystem(new OpponentAI(1, enemyDifficulty))
  seedScenario(world)

  let steps = 0
  const start = Date.now()
  while (world.winner === -1 && steps < maxSteps) {
    world.update(STEP)
    steps += 1
  }
  const durationSeconds = (Date.now() - start) / 1000

  let playerUnits = 0
  let enemyUnits = 0
  let playerBuildings = 0
  let enemyBuildings = 0
  for (const id of world.entities.keys()) {
    const team = world.team[id]
    const kind = world.kind[id]
    const isUnit = kind <= 2
    if (team === 0) {
      if (isUnit) playerUnits += 1
      else playerBuildings += 1
    } else {
      if (isUnit) enemyUnits += 1
      else enemyBuildings += 1
    }
  }

  return {
    winner: world.winner,
    steps,
    durationSeconds,
    playerUnits,
    enemyUnits,
    playerBuildings,
    enemyBuildings,
  }
}

/** CLI entry: run matches and print results. */
const _g = globalThis as unknown as { process?: { argv: string[] } }
if (typeof _g.process !== 'undefined' && _g.process.argv[1]?.includes('match')) {
  const args = _g.process!.argv.slice(2)
  const pDiff = (args[0] as AIDifficulty) || 'normal'
  const eDiff = (args[1] as AIDifficulty) || 'normal'
  const count = parseInt(args[2] || '1', 10)
  console.log(`Running ${count} match(es): ${pDiff} vs ${eDiff}`)
  for (let i = 0; i < count; i += 1) {
    const r = runMatch(pDiff, eDiff)
    const mins = (r.steps / 60 / 60).toFixed(1)
    console.log(
      `Match ${i + 1}: winner=${r.winner === 0 ? 'player' : r.winner === 1 ? 'enemy' : 'timeout'} ` +
        `(${mins} min sim, ${r.durationSeconds.toFixed(1)}s wall) ` +
        `units ${r.playerUnits}v${r.enemyUnits}`,
    )
  }
}
