/**
 * Session regression tests — save/load round-trip determinism and replay.
 */
import { World, TEAM_PLAYER, KIND_WORKER, STATE_IDLE, STATE_HOLD } from '../core/World.ts'
import { serializeWorld, deserializeWorld } from '../session/save-load.ts'
import { CommandLog } from '../session/commands.ts'
import { ReplayPlayer } from '../session/replay.ts'
import { applyCommand } from '../net/apply.ts'
import { hashWorldState, hashToHex } from '../net/hash.ts'
import { orderMove } from '../systems/movement.ts'
import { suite, test, assert, assertEqual } from './harness.ts'
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

test('round-trip preserves fog visibleNow and stays in sync', () => {
  const world = makeWorld()
  stepWorld(world, 120) // vision updates populate the pending-demotion sets
  const before = world.fog.map((f) => f.snapshotVisibleNow())
  assert(
    before.some((v) => v.length > 0),
    'sanity: some cells are currently visible',
  )
  const save = serializeWorld(world, 120, [])
  const restored = makeWorld()
  deserializeWorld(restored, save)
  const after = restored.fog.map((f) => f.snapshotVisibleNow())
  assertEqual(after.length, before.length, 'one visibleNow set per team')
  for (let t = 0; t < before.length; t += 1) {
    assertEqual(
      after[t].join(','),
      before[t].join(','),
      `team ${t}: visibleNow survives the round-trip`,
    )
  }
  // The real bug: without visibleNow the restored world's NEXT vision
  // update diverges. Step both worlds and require identical fog state.
  stepWorld(world, 60)
  stepWorld(restored, 60)
  for (let t = 0; t < before.length; t += 1) {
    assertEqual(
      restored.fog[t].snapshotVisibleNow().join(','),
      world.fog[t].snapshotVisibleNow().join(','),
      `team ${t}: fog still in sync after 60 more steps`,
    )
    assertEqual(
      restored.fog[t].snapshotCells().join(','),
      world.fog[t].snapshotCells().join(','),
      `team ${t}: fog cells still in sync after 60 more steps`,
    )
  }
})

test('saves predating fogVisibleNow still load (empty pending set)', () => {
  const world = makeWorld()
  stepWorld(world, 120)
  const save = serializeWorld(world, 120, [])
  delete (save as Partial<typeof save>).fogVisibleNow
  const restored = makeWorld()
  deserializeWorld(restored, save) // must not throw
  for (const fog of restored.fog) {
    assertEqual(fog.snapshotVisibleNow().length, 0, 'pending set restores empty')
  }
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

test('replay reproduces live stop and hold orders (audit item 6)', () => {
  const TICKS = 360
  // Two player workers: A is move->stop, B is move->hold.
  const worldLive = makeWorld()
  const workers: number[] = []
  for (const id of worldLive.entities.keys()) {
    if (worldLive.team[id] === TEAM_PLAYER && worldLive.kind[id] === KIND_WORKER) workers.push(id)
  }
  assert(workers.length >= 2, 'sanity: at least two player workers')
  const [wA, wB] = workers
  const startA = { x: worldLive.positionX[wA], z: worldLive.positionZ[wA] }

  const log = new CommandLog()
  log.record({ type: 'move', step: 30, unitIds: [wA], x: 10, z: 10 })
  log.record({ type: 'stop', step: 90, unitIds: [wA] })
  log.record({ type: 'move', step: 30, unitIds: [wB], x: -12, z: 4 })
  log.record({ type: 'hold', step: 60, unitIds: [wB] })
  const commands = log.getCommands()

  // Live run: commands applied through the live path (net/apply.ts).
  for (let s = 0; s < TICKS; s += 1) {
    for (const cmd of commands) if (cmd.step === s) applyCommand(worldLive, cmd)
    worldLive.update(STEP)
  }

  // Replay run: fresh world, commands re-applied by ReplayPlayer.
  const worldReplay = makeWorld()
  const replay = new ReplayPlayer(worldReplay)
  replay.load(commands)
  for (let s = 0; s < TICKS; s += 1) replay.update(STEP)

  const hashLive = hashWorldState(worldLive)
  const hashReplay = hashWorldState(worldReplay)
  console.log(
    `replay-stop-hold probe: ticks=${TICKS} liveHash=${hashToHex(hashLive)} replayHash=${hashToHex(hashReplay)}`,
  )
  assert(hashReplay === hashLive, 'replay hash equals live hash exactly')
  assertEqual(fingerprint(worldReplay), fingerprint(worldLive), 'replay fingerprint equals live')

  // The orders visibly took effect in BOTH runs (not just vacuously equal):
  for (const w of [worldLive, worldReplay]) {
    assertEqual(w.state[wA], STATE_IDLE, 'stopped worker is IDLE')
    const dA = Math.hypot(w.positionX[wA] - 10, w.positionZ[wA] - 10)
    assert(dA > 2, 'stopped worker never reached its move target')
    const moved = Math.hypot(w.positionX[wA] - startA.x, w.positionZ[wA] - startA.z)
    assert(moved > 0.5, 'stopped worker had actually moved before the stop')
    assertEqual(w.state[wB], STATE_HOLD, 'held worker is in STATE_HOLD')
    const dB = Math.hypot(w.positionX[wB] - -12, w.positionZ[wB] - 4)
    assert(dB > 2, 'held worker stopped short of its move target')
  }
})

test('replay reproduces a live surrender (audit item 6)', () => {
  const TICKS = 60
  const log = new CommandLog()
  log.record({ type: 'surrender', step: 10, player: 0 })
  const commands = log.getCommands()

  const worldLive = makeWorld()
  for (let s = 0; s < TICKS; s += 1) {
    for (const cmd of commands) if (cmd.step === s) applyCommand(worldLive, cmd)
    worldLive.update(STEP)
  }
  assertEqual(worldLive.winner, 1, 'live: surrender by player 0 makes team 1 the winner')

  const worldReplay = makeWorld()
  const replay = new ReplayPlayer(worldReplay)
  replay.load(commands)
  for (let s = 0; s < TICKS; s += 1) replay.update(STEP)

  assertEqual(worldReplay.winner, 1, 'replay: surrender is applied, winner matches live')
  assert(
    hashWorldState(worldReplay) === hashWorldState(worldLive),
    'replay hash equals live hash after surrender',
  )
})
