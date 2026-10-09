/**
 * Session regression tests — save/load round-trip determinism and replay.
 */
import { World, TEAM_PLAYER } from '../core/World.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'
import { ReplayPlayer } from '../session/replay.ts'
import { orderMove } from '../systems/movement.ts'
import { suite, test, assertEqual } from './harness.ts'
import { makeWorld, stepWorld, STEP } from './setup.ts'

/** Fingerprint of world state for determinism comparison. */
function fingerprint(world: World): string {
  const parts: string[] = []
  parts.push(`gold:${Math.floor(world.gold[0])},${Math.floor(world.gold[1])}`)
  parts.push(`wood:${Math.floor(world.wood[0])},${Math.floor(world.wood[1])}`)
  parts.push(`winner:${world.winner}`)
  const ids = [...world.entities.keys()].sort((a, b) => a - b)
  parts.push(`count:${ids.length}`)
  for (const id of ids) {
    parts.push(
      `${id}:${world.kind[id]},${world.team[id]},${Math.floor(world.health[id])},${world.positionX[id].toFixed(2)},${world.positionZ[id].toFixed(2)}`,
    )
  }
  return parts.join('|')
}

suite('save/load')
test('round-trip preserves world state', () => {
  const world = makeWorld()
  // Issue a move and step a bit.
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_PLAYER && world.kind[id] === 0) {
      orderMove(world, id, 0, 0)
      break
    }
  }
  stepWorld(world, 120)
  const before = fingerprint(world)

  const save = serializeWorld(world, 120, [])
  const world2 = new World()
  deserializeWorld(world2, save)
  const after = fingerprint(world2)
  assertEqual(after, before, 'deserialized world matches original')
})

test('save/load preserves commands', () => {
  const world = makeWorld()
  const cmds = [{ type: 'move', step: 10, unitIds: [1], x: 5, z: 5 }] as const
  const save = serializeWorld(world, 10, cmds as never)
  assertEqual(save.commands.length, 1, 'command preserved in save')
})

suite('replay')
test('replay re-simulation is deterministic', () => {
  // Run A: live sim with commands applied at steps.
  const worldA = makeWorld()
  let workerA = -1
  for (const id of worldA.entities.keys()) {
    if (worldA.team[id] === TEAM_PLAYER && worldA.kind[id] === 0) {
      workerA = id
      break
    }
  }
  const commands = [{ type: 'move', step: 30, unitIds: [workerA], x: 10, z: 10 }] as never[]
  const replay = new ReplayPlayer(worldA)
  replay.load(commands)
  for (let s = 0; s < 300; s += 1) replay.update(STEP)
  const fpA = fingerprint(worldA)

  // Run B: fresh world, same commands, same steps.
  const worldB = makeWorld()
  let workerB = -1
  for (const id of worldB.entities.keys()) {
    if (worldB.team[id] === TEAM_PLAYER && worldB.kind[id] === 0) {
      workerB = id
      break
    }
  }
  const commandsB = [{ type: 'move', step: 30, unitIds: [workerB], x: 10, z: 10 }] as never[]
  const replayB = new ReplayPlayer(worldB)
  replayB.load(commandsB)
  for (let s = 0; s < 300; s += 1) replayB.update(STEP)
  const fpB = fingerprint(worldB)

  assertEqual(fpB, fpA, 'two replay runs produce identical state')
})
