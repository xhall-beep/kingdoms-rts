/**
 * ScriptedDriver: deterministic, state-dependent input generator for
 * lockstep tests. Issues the same style of commands a human would —
 * gather, build, train, attack-move, patrol — derived purely from the
 * world state and the turn number (no RNG, no wall clock).
 *
 * Both drivers run the same script for their own team, so the two peers
 * generate different command streams (different entity ids, mirrored
 * positions) that must still keep the simulations identical.
 */
import {
  World,
  KIND_WORKER,
  KIND_TREE,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_BARRACKS,
  KIND_MELEE,
  TEAM_PLAYER,
} from '../core/World.ts'
import type { Command } from '../session/commands.ts'

function teamOf(playerIndex: number): 0 | 1 {
  return playerIndex === 0 ? 0 : 1
}

function myWorkers(world: World, team: 0 | 1): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_WORKER) out.push(id)
  }
  return out
}

function myHall(world: World, team: 0 | 1): number {
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_HALL) return id
  }
  return -1
}

function myBarracks(world: World, team: 0 | 1): number {
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_BARRACKS) return id
  }
  return -1
}

function myArmy(world: World, team: 0 | 1): number[] {
  const out: number[] = []
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && (world.kind[id] === KIND_MELEE || world.kind[id] === KIND_WORKER)) {
      out.push(id)
    }
  }
  return out
}

function nearestNode(world: World, x: number, z: number, kind: number): number {
  let best = -1
  let bestD = Infinity
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind || world.amount[id] <= 0) continue
    const dx = world.positionX[id] - x
    const dz = world.positionZ[id] - z
    const d = dx * dx + dz * dz
    if (d < bestD) {
      bestD = d
      best = id
    }
  }
  return best
}

export class ScriptedDriver {
  readonly playerIndex: number

  constructor(playerIndex: number) {
    this.playerIndex = playerIndex
  }

  /**
   * Commands this player issues for the given turn. Called with the peer's
   * local world (identical across peers by lockstep construction).
   */
  commandsForTurn(world: World, turn: number): Command[] {
    const team = teamOf(this.playerIndex)
    const enemyTeam = team === TEAM_PLAYER ? 1 : 0
    const out: Command[] = []
    const workers = myWorkers(world, team)
    if (workers.length === 0) return out
    const hall = myHall(world, team)
    const hx = hall >= 0 ? world.positionX[hall] : 0
    const hz = hall >= 0 ? world.positionZ[hall] : 0
    // Mirror sign so both teams play "their" side.
    const s = team === TEAM_PLAYER ? 1 : -1

    switch (turn) {
      case 2: {
        // Opening: split workers between gold and wood.
        const gold = nearestNode(world, hx, hz, KIND_GOLDMINE)
        const tree = nearestNode(world, hx, hz, KIND_TREE)
        workers.forEach((w, i) => {
          const node = i % 2 === 0 ? gold : tree
          if (node >= 0) out.push({ type: 'gather', step: 0, unitIds: [w], nodeId: node })
        })
        break
      }
      case 20: {
        // First farm next to the hall.
        out.push({
          type: 'build', step: 0, workerId: workers[0],
          building: 'farm', x: hx + s * 10, z: hz + s * 6, siteId: 0,
        })
        break
      }
      case 60: {
        // Barracks for military production.
        if (workers.length > 1) {
          out.push({
            type: 'build', step: 0, workerId: workers[1],
            building: 'barracks', x: hx + s * 14, z: hz - s * 8, siteId: 0,
          })
        }
        break
      }
      case 120: {
        // Queue melee units if the barracks finished.
        const rax = myBarracks(world, team)
        if (rax >= 0) {
          out.push({ type: 'train', step: 0, buildingId: rax, unit: 'melee' })
          out.push({ type: 'train', step: 0, buildingId: rax, unit: 'melee' })
        }
        // Reassign half the workers to wood for the war economy.
        const tree = nearestNode(world, hx, hz, KIND_TREE)
        if (tree >= 0) {
          out.push({
            type: 'gather', step: 0,
            unitIds: workers.filter((_, i) => i % 2 === 1), nodeId: tree,
          })
        }
        break
      }
      case 200: {
        // The push: everything attacks toward the enemy hall.
        const eHall = myHall(world, enemyTeam as 0 | 1)
        const ex = eHall >= 0 ? world.positionX[eHall] : -hx
        const ez = eHall >= 0 ? world.positionZ[eHall] : -hz
        const army = myArmy(world, team)
        if (army.length > 0) {
          out.push({ type: 'attackmove', step: 0, unitIds: army, x: ex, z: ez })
        }
        break
      }
      case 320: {
        // Regroup stragglers.
        const army = myArmy(world, team)
        if (army.length > 0) {
          out.push({ type: 'patrol', step: 0, unitIds: army, x: hx, z: hz })
        }
        break
      }
      default: {
        // Steady micro: every 25 turns, nudge a worker (keeps input
        // flowing through the protocol the whole match).
        if (turn > 10 && turn % 25 === 0 && workers.length > 2) {
          const w = workers[(turn / 25) % workers.length | 0]
          out.push({
            type: 'move', step: 0, unitIds: [w],
            x: hx + s * ((turn * 7) % 20 - 10), z: hz + s * ((turn * 13) % 20 - 10),
          })
        }
        break
      }
    }
    return out
  }
}
