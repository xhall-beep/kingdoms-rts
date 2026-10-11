/**
 * Applies a network command to a world. Mirrors ReplayPlayer's logic, but as
 * a standalone function so the lockstep turn manager doesn't depend on the
 * replay subsystem. Team for build placement is derived from the worker
 * (replays hardcode team 0; PvP needs the acting player's team).
 */
import {
  World,
  KIND_TREE,
  KIND_WORKER,
  HARVEST_WOOD,
  HARVEST_GOLD,
} from '../core/World.ts'
import { orderAttack, orderAttackMove } from '../systems/combat.ts'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderMove, orderPatrol, orderStop, orderHold } from '../systems/movement.ts'
import { enqueueTrain, setRally } from '../systems/production.ts'
import { placeStructure } from '../world/construction.ts'
import type { Command } from '../session/commands.ts'

export function applyCommand(world: World, cmd: Command): void {
  switch (cmd.type) {
    case 'move':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id)) orderMove(world, id, cmd.x, cmd.z)
      }
      break
    case 'attack':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id) && world.entities.has(cmd.targetId)) {
          orderAttack(world, id, cmd.targetId)
        }
      }
      break
    case 'attackmove':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id)) orderAttackMove(world, id, cmd.x, cmd.z)
      }
      break
    case 'gather': {
      const node = world.entities.has(cmd.nodeId) ? cmd.nodeId : -1
      if (node === -1) break
      const want = world.kind[node] === KIND_TREE ? HARVEST_WOOD : HARVEST_GOLD
      for (const id of cmd.unitIds) {
        if (!world.entities.has(id) || world.kind[id] !== KIND_WORKER) continue
        world.harvestKind[id] = want
        orderGather(world, id)
      }
      break
    }
    case 'build': {
      // Deterministic placement: both peers place from identical state, so
      // the structure id matches on both sides. Team comes from the worker.
      const team = world.entities.has(cmd.workerId)
        ? ((world.team[cmd.workerId] === 1 ? 1 : 0) as 0 | 1)
        : (0 as const)
      const placed = placeStructure(world, team, cmd.building, cmd.x, cmd.z)
      if (placed.ok && world.entities.has(cmd.workerId)) {
        orderBuild(world, cmd.workerId, placed.id)
      }
      break
    }
    case 'train':
      if (world.entities.has(cmd.buildingId)) {
        enqueueTrain(world, cmd.buildingId, cmd.unit)
      }
      break
    case 'rally':
      if (world.entities.has(cmd.buildingId)) {
        setRally(world, cmd.buildingId, cmd.x, cmd.z)
      }
      break
    case 'patrol':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id)) orderPatrol(world, id, cmd.x, cmd.z)
      }
      break
    case 'stop':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id)) orderStop(world, id)
      }
      break
    case 'hold':
      for (const id of cmd.unitIds) {
        if (world.entities.has(id)) orderHold(world, id)
      }
      break
  }
}
