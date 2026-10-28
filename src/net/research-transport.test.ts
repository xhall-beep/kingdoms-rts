/**
 * Research transport tests — the two breaks from the Game Tester's
 * tech-gates charter (2026-10-26), closed and pinned:
 *
 *  A7 (replay integrity): research had no Command representation and
 *     the HUD recorded nothing, so a match containing research
 *     replayed as a different match (live hash 3e8b0a8dbb4f5e1a vs
 *     replay 64c7490fb6c0f21a — the delta was exactly the 80g cost).
 *     The replay test below is that repro inverted: the recorded log
 *     now reproduces the identical final hash.
 *
 *  A4-adjacent (PvP desync): research — and, by the same HUD pattern,
 *     train / cancelTrain / militia / upgrade / warhorn — mutated the
 *     local world directly with no lockstep transport, so a tap in a
 *     live match changed one peer's hashed state alone. The two-peer
 *     test drives the real wire (protocol codec + ReliableLink +
 *     LockstepPeer) with both players issuing those commands and
 *     requires zero desyncs and identical end state.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_HALL,
  KIND_MELEE,
} from '../core/World.ts'
import { makeWorld, STEP } from '../tests/setup.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnCallbacks } from './turn.ts'
import { LoopbackTransport, ReliableLink } from './transport.ts'
import { applyCommand } from './apply.ts'
import { hashWorldState } from './hash.ts'
import { STEPS_PER_TURN, encodeMessage, decodeMessage, MsgKind } from './protocol.ts'
import { CommandLog } from '../session/commands.ts'
import type { Command } from '../session/commands.ts'
import { ReplayPlayer } from '../session/replay.ts'
import {
  enqueueTrain,
  researchUpgrade,
  researchCost,
  trainCostFor,
  trainQueueCount,
} from '../systems/production.ts'

/**
 * Identical pre-match staging on any world: finished tech chains for
 * both teams + rich treasuries. Applied in the same order everywhere,
 * so entity ids match across worlds (the lockstep precondition).
 */
interface Staged {
  smithy0: number
  barracks0: number
  range0: number
  smithy1: number
  barracks1: number
}

function stageTech(world: World): Staged {
  world.spawnBuilding('workshop', TEAM_PLAYER, -52, -40, true)
  const smithy0 = world.spawnBuilding('smithy', TEAM_PLAYER, -52, -26, true).id
  const barracks0 = world.spawnBuilding('barracks', TEAM_PLAYER, -26, -54, true).id
  const range0 = world.spawnBuilding('archery', TEAM_PLAYER, -54, -54, true).id
  world.spawnBuilding('workshop', TEAM_ENEMY, 52, 40, true)
  const smithy1 = world.spawnBuilding('smithy', TEAM_ENEMY, 52, 26, true).id
  const barracks1 = world.spawnBuilding('barracks', TEAM_ENEMY, 26, 54, true).id
  world.spawnBuilding('archery', TEAM_ENEMY, 54, 54, true)
  world.gold[TEAM_PLAYER] = 100000
  world.gold[TEAM_ENEMY] = 100000
  world.wood[TEAM_PLAYER] = 100000
  world.wood[TEAM_ENEMY] = 100000
  return { smithy0, barracks0, range0, smithy1, barracks1 }
}

function findHall(world: World, team: 0 | 1): number {
  for (const id of world.entities.keys()) {
    if (world.team[id] === team && world.kind[id] === KIND_HALL) return id
  }
  return -1
}

// ---------------------------------------------------------------------------
// Two-peer wire proof
// ---------------------------------------------------------------------------

suite('net research transport: two-peer lockstep')

test('research + train + cancel over the wire: zero desyncs, identical end state', () => {
  const TURNS = 240
  const worlds = [makeWorld(), makeWorld()]
  const staged = worlds.map((w) => stageTech(w))
  const s = staged[0]
  assertEqual(staged[1].smithy0, s.smithy0, 'staging assigns identical ids on both peers')

  const net = new LoopbackTransport()
  let desyncs = 0
  let hashesCompared = 0
  const peers: LockstepPeer[] = []
  const links: ReliableLink[] = []
  for (let p = 0; p < 2; p += 1) {
    const world = worlds[p]
    const link = new ReliableLink(net, p, 1 - p)
    links.push(link)
    const callbacks: TurnCallbacks = {
      executeTurn: (_turn: number, _step: number, commands: Command[]) => {
        for (const c of commands) applyCommand(world, c)
        for (let i = 0; i < STEPS_PER_TURN; i += 1) world.update(STEP)
      },
      computeHash: (_turn: number): bigint => hashWorldState(world),
      onRemoteHash: (_turn: number, _remote: bigint, _local: bigint, match: boolean) => {
        hashesCompared += 1
        if (!match) desyncs += 1
      },
      onStall: (_turn: number, _waitedMs: number) => {},
    }
    const peer = new LockstepPeer(p, 2, link, callbacks, { inputDelayTurns: 2 })
    peer.setTurnLimit(TURNS)
    peers.push(peer)
  }
  ReliableLink.wire(net, links[0], links[1])

  // The command script: each peer issues HUD-class commands for its own
  // team, queued through its peer exactly as PvPGame now routes them.
  let issued0a = false
  let issued0b = false
  let issued1a = false
  let issued1b = false
  const issue = (): void => {
    const t0 = peers[0].getCurrentTurn()
    const t1 = peers[1].getCurrentTurn()
    if (!issued0a && t0 >= 2) {
      issued0a = true
      peers[0].queueCommand({ type: 'research', step: 0, buildingId: s.smithy0, team: 0, upgrade: 'meleeDmg' })
      peers[0].queueCommand({ type: 'train', step: 0, buildingId: s.barracks0, unit: 'melee', team: 0})
      peers[0].queueCommand({ type: 'train', step: 0, buildingId: s.barracks0, unit: 'melee', team: 0})
    }
    if (!issued0b && t0 >= 8) {
      issued0b = true
      // Cancel the still-queued second melee (the first is training).
      peers[0].queueCommand({ type: 'cancelTrain', step: 0, buildingId: s.barracks0, index: 0, team: 0})
      peers[0].queueCommand({ type: 'research', step: 0, buildingId: s.range0, team: 0, upgrade: 'rangedDmg' })
      peers[0].queueCommand({ type: 'militia', step: 0, team: 0 })
      peers[0].queueCommand({ type: 'warhorn', step: 0, team: 0, rally: 1 })
      peers[0].queueCommand({ type: 'upgrade', step: 0, buildingId: s.barracks0, team: 0 })
    }
    if (!issued1a && t1 >= 4) {
      issued1a = true
      peers[1].queueCommand({ type: 'research', step: 0, buildingId: s.smithy1, team: 1, upgrade: 'meleeHp' })
      peers[1].queueCommand({ type: 'train', step: 0, buildingId: s.barracks1, unit: 'ranged', team: 1})
    }
    if (!issued1b && t1 >= 10) {
      issued1b = true
      // Cancel team 1's active train outright.
      peers[1].queueCommand({ type: 'cancelTrain', step: 0, buildingId: s.barracks1, index: -1, team: 1})
    }
  }

  let nowMs = 0
  let guard = 0
  while (peers.some((p) => p.getCurrentTurn() < TURNS) && guard < 2000000) {
    guard += 1
    nowMs += 5
    issue()
    net.pump(nowMs)
    for (const link of links) link.pump(nowMs)
    for (const peer of peers) peer.pump(nowMs)
  }

  assert(issued0a && issued0b && issued1a && issued1b, 'the whole script was issued')
  assertEqual(peers[0].getCurrentTurn(), TURNS, 'peer 0 executed all turns')
  assertEqual(peers[1].getCurrentTurn(), TURNS, 'peer 1 executed all turns')
  assertEqual(desyncs, 0, 'zero desyncs across the wire')
  assert(hashesCompared >= 6, `hash exchanges happened (${hashesCompared})`)
  assertEqual(
    hashWorldState(worlds[0]),
    hashWorldState(worlds[1]),
    'final world hashes identical',
  )

  // End state: the transported commands landed — on BOTH peers' views
  // of BOTH teams (each world simulates both teams).
  for (const w of worlds) {
    assertEqual(w.meleeDmgLvl[TEAM_PLAYER], 1, 'team 0 weapon research landed')
    assertEqual(w.rangedDmgLvl[TEAM_PLAYER], 1, 'team 0 ranged research landed')
    assertEqual(w.meleeHpLvl[TEAM_ENEMY], 1, 'team 1 armor research landed')
    assertEqual(trainQueueCount(w, s.barracks0), 0, 'team 0 queue drained (1 trained, 1 cancelled)')
    let melee = 0
    for (const id of w.entities.keys()) {
      if (w.team[id] === TEAM_PLAYER && w.kind[id] === KIND_MELEE) melee += 1
    }
    assert(melee >= 1, 'the surviving team 0 train completed into a melee unit')
  }
  // Cross-peer accounting: whatever the seeded workers gathered or
  // the militia muster cost in tempo, both peers' ledgers for BOTH
  // teams agree to the gold piece — the wire kept the books identical.
  // (Absolute per-command charges are pinned exactly in the ledger
  // test below; a live world's gathering makes end-of-match totals
  // the wrong place to assert them.)
  assertEqual(worlds[1].gold[TEAM_PLAYER], worlds[0].gold[TEAM_PLAYER], 'peer agreement: team 0 gold')
  assertEqual(worlds[1].gold[TEAM_ENEMY], worlds[0].gold[TEAM_ENEMY], 'peer agreement: team 1 gold')
  assertEqual(worlds[1].wood[TEAM_PLAYER], worlds[0].wood[TEAM_PLAYER], 'peer agreement: team 0 wood')
})

// ---------------------------------------------------------------------------
// Apply-path validation parity (the A4 gates, for the new command)
// ---------------------------------------------------------------------------

suite('net research transport: apply validation')

test('apply ledger: research + train + queued-cancel charges are exact', () => {
  // No stepping: gathering never lands a deposit, so the ledger shows
  // exactly what the transported commands charge and refund.
  const w = makeWorld()
  const s = stageTech(w)
  const gold0 = w.gold[TEAM_PLAYER]
  const wood0 = w.wood[TEAM_PLAYER]
  applyCommand(w, { type: 'research', step: 0, buildingId: s.smithy0, team: 0, upgrade: 'meleeDmg' })
  applyCommand(w, { type: 'train', step: 0, buildingId: s.barracks0, unit: 'melee', team: 0})
  applyCommand(w, { type: 'train', step: 0, buildingId: s.barracks0, unit: 'melee', team: 0})
  applyCommand(w, { type: 'cancelTrain', step: 0, buildingId: s.barracks0, index: 0, team: 0})
  applyCommand(w, { type: 'research', step: 0, buildingId: s.range0, team: 0, upgrade: 'rangedDmg' })
  const spend =
    researchCost(w, TEAM_PLAYER, 'meleeDmg').gold +
    researchCost(w, TEAM_PLAYER, 'rangedDmg').gold +
    trainCostFor(w, TEAM_PLAYER, 'melee').gold
  assertEqual(
    w.gold[TEAM_PLAYER],
    gold0 - spend,
    'two researches + one net train (queued cancel refunded in full)',
  )
  const woodSpend =
    researchCost(w, TEAM_PLAYER, 'meleeDmg').wood +
    researchCost(w, TEAM_PLAYER, 'rangedDmg').wood +
    trainCostFor(w, TEAM_PLAYER, 'melee').wood
  assertEqual(w.wood[TEAM_PLAYER], wood0 - woodSpend, 'wood ledger matches too')
  assertEqual(trainQueueCount(w, s.barracks0), 1, 'the active train remains')
})

test('invalid research refuses identically on both peers (wrong host, no funds)', () => {
  const a = makeWorld()
  const b = makeWorld()
  // Wrong host: a hall is not a smithy.
  const hallA = findHall(a, TEAM_PLAYER)
  const hallB = findHall(b, TEAM_PLAYER)
  assertEqual(hallA, hallB, 'identical worlds, identical hall id')
  const bad: Command = { type: 'research', step: 0, buildingId: hallA, upgrade: 'meleeDmg', team: 0}
  applyCommand(a, bad)
  applyCommand(b, bad)
  assertEqual(a.meleeDmgLvl[TEAM_PLAYER], 0, 'wrong-host research refused (a)')
  assertEqual(b.meleeDmgLvl[TEAM_PLAYER], 0, 'wrong-host research refused (b)')
  assertEqual(hashWorldState(a), hashWorldState(b), 'refusals keep peers identical')

  // Right host, no funds.
  const sa = stageTech(a)
  const sb = stageTech(b)
  a.gold[TEAM_PLAYER] = 10
  b.gold[TEAM_PLAYER] = 10
  const broke: Command = { type: 'research', step: 0, buildingId: sa.smithy0, team: 0, upgrade: 'meleeDmg' }
  applyCommand(a, broke)
  applyCommand(b, { ...broke, buildingId: sb.smithy0 })
  assertEqual(a.meleeDmgLvl[TEAM_PLAYER], 0, 'unaffordable research refused (a)')
  assertEqual(b.meleeDmgLvl[TEAM_PLAYER], 0, 'unaffordable research refused (b)')
  assertEqual(a.gold[TEAM_PLAYER], 10, 'a refused research charges nothing')
  assertEqual(hashWorldState(a), hashWorldState(b), 'peers still identical')
})

test('unknown upgrade byte is rejected loudly, not silently desynced', () => {
  const bytes = encodeMessage({
    kind: MsgKind.Input,
    turn: 1,
    player: 0,
    commands: [{ type: 'research', step: 0, buildingId: 8, upgrade: 'meleeDmg' }],
  })
  bytes[bytes.length - 2] = 0xff // corrupt the upgrade byte (the trailing byte is the commanding team)
  let threw = false
  try {
    decodeMessage(bytes)
  } catch {
    threw = true
  }
  assert(threw, 'bad upgrade byte must throw')
})

// ---------------------------------------------------------------------------
// Replay proof (the A7 repro, inverted)
// ---------------------------------------------------------------------------

suite('net research transport: replay fidelity')

test('a recorded match with research + archer training replays to the identical hash', () => {
  const STEPS = 660
  const AT = 60

  // Live run: at step 60 do exactly what the fixed HUD callbacks do —
  // apply locally and record on success.
  const live = makeWorld()
  const ls = stageTech(live)
  const log = new CommandLog()
  for (let i = 0; i < STEPS; i += 1) {
    if (i === AT) {
      if (researchUpgrade(live, ls.smithy0, 'meleeDmg')) {
        log.record({ type: 'research', step: AT, buildingId: ls.smithy0, upgrade: 'meleeDmg', team: 0})
      }
      if (enqueueTrain(live, ls.barracks0, 'ranged')) {
        log.record({ type: 'train', step: AT, buildingId: ls.barracks0, unit: 'ranged', team: 0})
      }
    }
    live.update(STEP)
  }
  assertEqual(log.length, 2, 'both commands were recorded')
  assertEqual(live.meleeDmgLvl[TEAM_PLAYER], 1, 'live: research landed')
  const liveHash = hashWorldState(live)
  const liveGold = live.gold[TEAM_PLAYER]

  // Replay run: fresh staged world + the recorded log only.
  const replayed = makeWorld()
  stageTech(replayed)
  const player = new ReplayPlayer(replayed)
  player.load(log.getCommands())
  for (let i = 0; i < STEPS; i += 1) player.update(STEP)

  assertEqual(replayed.meleeDmgLvl[TEAM_PLAYER], 1, 'replay: research landed')
  assertEqual(replayed.gold[TEAM_PLAYER], liveGold, 'replay: gold identical (no missing 80g)')
  assertEqual(hashWorldState(replayed), liveHash, 'replay: final hash identical to live')
})
