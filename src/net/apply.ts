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
  KIND_HALL,
  KIND_FARM,
  KIND_TOWER,
  HARVEST_WOOD,
  HARVEST_GOLD,
} from '../core/World.ts'
import { orderAttack, orderAttackMove } from '../systems/combat.ts'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderMove, orderPatrol, orderStop, orderHold } from '../systems/movement.ts'
import { cancelTrainActive, cancelTrainQueued, enqueueTrain, setRally, upgradeBuilding } from '../systems/production.ts'
import { soundWarHorn } from '../systems/warhorn.ts'
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
      // Resume: a nonzero siteId targets an existing incomplete structure —
      // send the worker back to it instead of placing a new one. (The AI's
      // construction supervisor emits this when a builder is lost mid-build;
      // the player input layer emits it when workers are ordered onto an
      // unfinished structure to join its crew. Towers sit outside the
      // HALL..FARM kind range and are included explicitly.)
      if (cmd.siteId !== 0 && world.entities.has(cmd.siteId)) {
        const site = cmd.siteId
        const skind = world.kind[site]
        if (
          world.team[site] === team &&
          ((skind >= KIND_HALL && skind <= KIND_FARM) || skind === KIND_TOWER) &&
          world.buildProgress[site] < world.buildTotal[site] &&
          world.entities.has(cmd.workerId) &&
          world.kind[cmd.workerId] === KIND_WORKER
        ) {
          orderBuild(world, cmd.workerId, site)
        }
        break
      }
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
    case 'cancelTrain':
      if (world.entities.has(cmd.buildingId)) {
        if (cmd.index < 0) cancelTrainActive(world, cmd.buildingId)
        else cancelTrainQueued(world, cmd.buildingId, cmd.index)
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
    case 'militia':
      world.ringMilitiaBell(cmd.team)
      break
    case 'upgrade':
      if (world.entities.has(cmd.buildingId)) upgradeBuilding(world, cmd.buildingId)
      break
    case 'warhorn':
      soundWarHorn(world, cmd.team, cmd.rally)
      break
    case 'surrender':
      // A player forfeits: their opponent wins. Guarded so a surrender
      // racing a natural victory can't flip an already-decided result.
      if (world.winner === -1) world.winner = cmd.player === 0 ? 1 : 0
      break
    case 'pvp-setup':
      // Consumed by the PvP match handshake (pvp-game.ts) before commands
      // are applied: by the time applyCommand runs, both peers have already
      // reseeded the world identically. Late/duplicate declarations are
      // ignored deterministically by the handshake itself.
      break
  }
}
