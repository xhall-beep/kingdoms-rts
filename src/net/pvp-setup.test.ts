/**
 * PvP match-opening handshake tests.
 *
 * The fixed bug: a PvP match started from each phone's divergent live
 * single-player state, so lockstep hashed different worlds and cried desync
 * on the first verified turn. These tests prove the turn-0 handshake
 * (one pvp-setup command per side -> identical reseed) erases arbitrary
 * play history, and that two lockstep peers actually converge.
 */
import { suite, test, assert, assertEqual } from '../tests/harness.ts'
import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_WORKER } from '../core/World.ts'
import { makeWorld, stepWorld } from '../tests/setup.ts'
import { serializeWorld } from '../session/save-load.ts'
import { BellSystemImpl } from '../systems/bells.ts'
import { SeasonSystemImpl } from '../systems/season.ts'
import { hashWorldState } from './hash.ts'
import { applyCommand } from './apply.ts'
import { LockstepPeer } from './turn.ts'
import type { TurnCallbacks } from './turn.ts'
import { WsLink } from './ws-link.ts'
import {
  MsgKind,
  STEPS_PER_TURN,
  HASH_EVERY_TURNS,
  encodeMessage,
  decodeMessage,
  messageSize,
  factionToByte,
  byteToFaction,
} from './protocol.ts'
import type { Command } from '../session/commands.ts'
import type { FactionId } from '../data/factions.ts'
import { ShrineSystemImpl } from '../systems/shrines.ts'
import {
  PVP_SETUP_ENTITY_ARRAYS,
  createPvpSetupHandshake,
  notePvpSetupCommand,
  resetWorldForMatch,
} from './pvp-setup.ts'

/** Pristine boot snapshot, the way main.ts captures initialSave. */
function bootSnapshot() {
  const world = makeWorld()
  return serializeWorld(world, 0, [])
}

/** Mangle a world the way real play would: time, combat, economy, kills. */
function dirtyTheWorld(world: World): void {
  stepWorld(world, 1200) // 20s of live systems (bells, vision, victory timers)
  world.matchTime = 400 // past the Second Bell: winter on one side only
  world.tick = 987654
  world.gold[TEAM_PLAYER] = 5000
  world.wood[TEAM_ENEMY] = 1234
  world.meleeDmgLvl[TEAM_PLAYER] = 3
  world.rangedDmgLvl[TEAM_ENEMY] = 2
  world.season = 1
  world.soulAsh[TEAM_ENEMY] = 42
  world.warCharge[TEAM_PLAYER] = 77
  world.victoryPoints[TEAM_ENEMY] = 500
  // Kill half the units, spawn replacements (id recycling churn).
  const ids = [...world.entities.keys()]
  for (let i = 0; i < ids.length; i += 2) world.removeEntityById(ids[i])
  world.spawnUnit('worker', TEAM_PLAYER, -30, -30)
  world.spawnUnit('melee', TEAM_ENEMY, 30, 30)
  world.spawnBuilding('farm', TEAM_PLAYER, -45, -35, true)
  stepWorld(world, 300)
}

suite('pvp-setup: deterministic reset')

test('reset erases arbitrary play history (hash-identical worlds)', () => {
  const pristine = bootSnapshot()
  const a = makeWorld()
  const b = makeWorld()
  // Full v2.0 system set on both, so the timer-reset paths are exercised too.
  for (const w of [a, b]) {
    w.registerSystem(new BellSystemImpl())
    w.registerSystem(new SeasonSystemImpl())
    w.registerSystem(new ShrineSystemImpl())
  }
  dirtyTheWorld(b)
  assert(hashWorldState(a) !== hashWorldState(b), 'precondition: histories differ')

  resetWorldForMatch(a, pristine, ['elf', 'undead'])
  resetWorldForMatch(b, pristine, ['elf', 'undead'])

  assertEqual(hashWorldState(a), hashWorldState(b), 'reset worlds hash identically')
  assertEqual(a.entities.size, b.entities.size, 'same entity count')
  assertEqual(
    [...a.entities.keys()].sort((x, y) => x - y).join(','),
    [...b.entities.keys()].sort((x, y) => x - y).join(','),
    'same entity ids',
  )
  assertEqual(a.factionOfTeam[0], 'elf', 'team 0 faction')
  assertEqual(a.factionOfTeam[1], 'undead', 'team 1 faction')
  assertEqual(a.matchTime, 0, 'match clock reset')
  assertEqual(a.season, 0, 'season reset')
  assertEqual(a.winner, -1, 'winner reset')
  assertEqual(a.tick, 0, 'sim tick reset')
  assertEqual(a.gold[TEAM_PLAYER], 200, 'starting gold')
  assertEqual(a.meleeDmgLvl[TEAM_PLAYER], 0, 'upgrade levels reset')
  console.log(`  reset: ${a.entities.size} entities, hash ${hashWorldState(a).toString(16)}`)
})

test('reset covers every typed-array field on World', () => {
  const world = new World()
  const missing: string[] = []
  const listed = new Set<string>(PVP_SETUP_ENTITY_ARRAYS)
  for (const key of Object.keys(world)) {
    const v = (world as unknown as Record<string, unknown>)[key]
    if (ArrayBuffer.isView(v) && !listed.has(key)) missing.push(key)
  }
  assertEqual(missing.length, 0, `uncovered typed arrays: ${missing.join(', ')}`)
})

test('reset reseed uses the agreed factions for spawn stats', () => {
  const pristine = bootSnapshot()
  const world = makeWorld()
  resetWorldForMatch(world, pristine, ['orc', 'orc'])
  // Orc racial: Drudge hauls double — spawn stats must reflect the NEW
  // factions, not the boot snapshot's human/orc pairing.
  let workerId = -1
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_WORKER && world.team[id] === TEAM_PLAYER) {
      workerId = id
      break
    }
  }
  assert(workerId !== -1, 'seeded worker exists')
  assert(world.carryMax[workerId] > 0, 'worker carryMax set from faction')
})

suite('pvp-setup: handshake')

test('pair completes when both sides declare', () => {
  const hs = createPvpSetupHandshake()
  const first = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 0, faction: 'elf' })
  assertEqual(first, null, 'one declaration is not enough')
  const pair = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 1, faction: 'undead' })
  assert(pair !== null, 'pair completes')
  assertEqual(pair![0], 'elf', 'slot 0 faction')
  assertEqual(pair![1], 'undead', 'slot 1 faction')
  assert(hs.seeded, 'marked seeded')
})

test('late, duplicate, and invalid declarations are ignored', () => {
  const hs = createPvpSetupHandshake()
  const dup = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 0, faction: 'elf' })
  assertEqual(dup, null, 'first declaration alone completes nothing')
  const dup2 = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 0, faction: 'orc' })
  assertEqual(dup2, null, 'duplicate declaration ignored')
  assertEqual(hs.factions[0], 'elf', 'first declaration wins')
  const badPlayer = notePvpSetupCommand(hs, {
    type: 'pvp-setup', step: 0, player: 2 as 0 | 1, faction: 'orc',
  })
  assertEqual(badPlayer, null, 'bad player ignored')
  const badFaction = notePvpSetupCommand(hs, {
    type: 'pvp-setup', step: 0, player: 1, faction: 'nope' as FactionId,
  })
  assertEqual(badFaction, null, 'unknown faction ignored')
  assertEqual(hs.factions[1], null, 'bad faction not recorded')
  const pair = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 1, faction: 'orc' })
  assert(pair !== null && pair[1] === 'orc', 'valid declaration still completes')
  const late = notePvpSetupCommand(hs, { type: 'pvp-setup', step: 0, player: 1, faction: 'human' })
  assertEqual(late, null, 'post-seed declarations ignored')
})

suite('pvp-setup: protocol')

test('pvp-setup command round-trips through the binary protocol', () => {
  const cmd: Command = { type: 'pvp-setup', step: 0, player: 1, faction: 'undead' }
  const msg: { kind: typeof MsgKind.Input; turn: number; player: 0 | 1; commands: Command[] } =
    { kind: MsgKind.Input, turn: 0, player: 1, commands: [cmd] }
  const bytes = encodeMessage(msg)
  assertEqual(bytes.byteLength, messageSize(msg), 'messageSize exact')
  const back = decodeMessage(bytes)
  assert(back.kind === MsgKind.Input, 'kind')
  if (back.kind === MsgKind.Input) {
    assertEqual(back.commands.length, 1, 'one command')
    const c = back.commands[0]
    assertEqual(c.type, 'pvp-setup', 'type survives')
    if (c.type === 'pvp-setup') {
      assertEqual(c.player, 1, 'player survives')
      assertEqual(c.faction, 'undead', 'faction survives')
    }
  }
})

test('faction byte mapping rejects unknowns loudly', () => {
  assertEqual(typeof factionToByte('human'), 'number', 'known faction maps')
  let threw = false
  try {
    factionToByte('nope' as FactionId)
  } catch {
    threw = true
  }
  assert(threw, 'unknown faction id throws')
  threw = false
  try {
    byteToFaction(255)
  } catch {
    threw = true
  }
  assert(threw, 'unknown faction byte throws')
})

suite('pvp-setup: two-peer convergence')

/**
 * Two lockstep peers with DIVERGENT pre-match histories run the real
 * turn-0 handshake (each declaring its own faction) and must converge to
 * identical worlds — the end-to-end proof the desync fix works.
 */
test('divergent peers converge via the turn-0 handshake', () => {
  const pristine = bootSnapshot()
  const worldA = makeWorld()
  const worldB = makeWorld()
  dirtyTheWorld(worldA) // phone A: 25s of play, winter, kills, upgrades
  // phone B: a totally different history
  stepWorld(worldB, 300)
  worldB.gold[TEAM_ENEMY] = 9999
  worldB.matchTime = 700
  worldB.spawnUnit('ranged', TEAM_PLAYER, 0, -50)

  const mismatches: { turn: number }[] = []
  const setupA = createPvpSetupHandshake()
  const setupB = createPvpSetupHandshake()
  const mkCallbacks = (
    world: World,
    setup: ReturnType<typeof createPvpSetupHandshake>,
  ): TurnCallbacks => ({
    executeTurn: (_turn: number, _step: number, commands: Command[]) => {
      if (!setup.seeded) {
        for (const cmd of commands) {
          if (cmd.type !== 'pvp-setup') continue
          const pair = notePvpSetupCommand(setup, cmd)
          if (pair !== null) resetWorldForMatch(world, pristine, pair)
        }
      }
      for (const cmd of commands) applyCommand(world, cmd)
      for (let i = 0; i < STEPS_PER_TURN; i += 1) world.update(1 / 60)
    },
    computeHash: () => hashWorldState(world),
    onRemoteHash: (turn, _remote, _local, match) => {
      if (!match) mismatches.push({ turn })
    },
    onStall: () => {},
  })
  // In-memory relay standing in for the Cloudflare worker (livePair pattern).
  let linkA: WsLink
  let linkB: WsLink
  linkA = new WsLink(
    (m) => linkB.receive(m),
    (m) => linkB.receive(m),
  )
  linkB = new WsLink(
    (m) => linkA.receive(m),
    (m) => linkA.receive(m),
  )
  const peerA = new LockstepPeer(0, 2, linkA, mkCallbacks(worldA, setupA))
  const peerB = new LockstepPeer(1, 2, linkB, mkCallbacks(worldB, setupB))

  peerA.queueCommand({ type: 'pvp-setup', step: 0, player: 0, faction: 'elf' })
  peerB.queueCommand({ type: 'pvp-setup', step: 0, player: 1, faction: 'undead' })

  let now = 1000
  const turns = HASH_EVERY_TURNS * 4 + 4
  for (let i = 0; i < turns; i += 1) {
    now += 250
    peerA.pump(now)
    peerB.pump(now)
  }

  assert(setupA.seeded && setupB.seeded, 'both peers seeded via handshake')
  assertEqual(worldA.factionOfTeam[0], 'elf', 'A: team 0 plays elf')
  assertEqual(worldA.factionOfTeam[1], 'undead', 'A: team 1 plays undead')
  assertEqual(worldB.factionOfTeam[0], 'elf', 'B: team 0 plays elf')
  assertEqual(worldB.factionOfTeam[1], 'undead', 'B: team 1 plays undead')
  assertEqual(hashWorldState(worldA), hashWorldState(worldB), 'peers converged to identical worlds')
  assertEqual(mismatches.length, 0, `no hash mismatches (got ${mismatches.length})`)
  console.log(`  converged after ${turns} turns, hash ${hashWorldState(worldA).toString(16)}`)
})
