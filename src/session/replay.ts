import type { World } from '../core/World'
import {
  HARVEST_GOLD,
  HARVEST_WOOD,
  KIND_TREE,
  KIND_WORKER,
} from '../core/World'
import { orderAttack, orderAttackMove } from '../systems/combat.ts'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderMove } from '../systems/movement.ts'
import { enqueueTrain, setRally } from '../systems/production.ts'
import { placeStructure } from '../world/construction.ts'
import type { Command } from './commands.ts'

/**
 * Replays a match by re-simulating from the initial state and applying the
 * recorded player commands at their original steps. The AI is deterministic,
 * so it makes the same decisions automatically — only player commands are
 * stored and replayed.
 */
export class ReplayPlayer {
  private readonly world: World
  private commands: Command[] = []
  private cmdIndex = 0
  private step = 0
  private playing = false
  private speed = 1

  constructor(world: World) {
    this.world = world
  }

  /** Load a command list and rewind to the start (world must be reset first). */
  load(commands: readonly Command[]): void {
    this.commands = [...commands].sort((a, b) => a.step - b.step)
    this.cmdIndex = 0
    this.step = 0
    this.playing = true
    this.speed = 1
  }

  get isPlaying(): boolean {
    return this.playing
  }

  getSpeed(): number {
    return this.speed
  }

  setSpeed(speed: number): void {
    this.speed = speed
  }

  pause(): void {
    this.playing = false
  }

  resume(): void {
    this.playing = true
  }

  getStep(): number {
    return this.step
  }

  getCommandCount(): number {
    return this.commands.length
  }

  /** Advance the simulation, applying commands due at each step. */
  update(dt: number): void {
    if (!this.playing) return
    // Fixed 60Hz steps, scaled by speed.
    const steps = Math.max(1, Math.round((dt * 60 * this.speed) / 1))
    for (let i = 0; i < steps; i += 1) {
      this.applyDueCommands()
      this.world.update(1 / 60)
      this.step += 1
    }
  }

  private applyDueCommands(): void {
    while (
      this.cmdIndex < this.commands.length &&
      this.commands[this.cmdIndex].step <= this.step
    ) {
      this.apply(this.commands[this.cmdIndex])
      this.cmdIndex += 1
    }
  }

  private apply(cmd: Command): void {
    const world = this.world
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
        const placed = placeStructure(world, 0, cmd.building, cmd.x, cmd.z)
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
    }
  }
}
