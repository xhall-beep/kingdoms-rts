/**
 * Basics slice 6 — "Shrine captures announce themselves"
 * (Montz's "Improve basics", 2026-11-02; basics audit F3, remaining half).
 *
 * Slice 3 bannered the first VP drain; the capture itself still had
 * no event class at all, so the ~0:10 moment the enemy took the
 * centre shrine passed in total silence. What is pinned here:
 *  - The shrine system pushes a 'shrine' alert on a holder CHANGE
 *    only, for the team that just LOST the shrine, at the shrine's
 *    position. Contested, empty, and unchanged holds push nothing.
 *  - In local play that is exactly the enemy-capture case: the
 *    player's own capture alerts the other team's viewer (PvP) and
 *    nobody in local play — good news needs no chip.
 *  - The chip channel stays visual-only: a queued shrine alert never
 *    moves the lockstep hash.
 *  - Priority sits between attack and treant (attack > shrine >
 *    treant > complete), with its own per-class cooldown, its own
 *    chip text, and its own chip styling class.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  World,
  TEAM_PLAYER,
  TEAM_ENEMY,
  KIND_SHRINE,
} from '../core/World.ts'
import type { AlertEvent, AlertKind } from '../core/World.ts'
import { hashWorldState } from '../net/hash.ts'
import { makeWorld, stepWorld } from './setup.ts'
import {
  ALERT_COOLDOWN_TICKS,
  ALERT_PRIORITY,
  ALERT_TEXT,
  pickAlert,
} from '../ui/hud.ts'

function shrineOf(world: World): number {
  for (const id of world.entities.keys()) {
    if (world.kind[id] === KIND_SHRINE) return id
  }
  throw new Error('scenario shrine not found')
}

function shrineAlerts(world: World): AlertEvent[] {
  return world.alertEvents.filter((e) => e.kind === 'shrine')
}

function readRepoFile(rel: string): string {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    `${here}../../${rel}`,
    `${here}../../../${rel}`,
    `/home/hatch/workspace/kingdoms-rts/${rel}`,
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  throw new Error(`cannot locate ${rel}`)
}

// ---------------------------------------------------------------------------
// Push site — the shrine system fills the channel on capture only
// ---------------------------------------------------------------------------

suite('basics slice 6: shrine capture alerts')

test('enemy capture pushes exactly one shrine alert for the player, at the shrine', () => {
  const world = makeWorld()
  const shrine = shrineOf(world)
  assertEqual(world.shrineHeld[shrine], -1, 'starts neutral')
  world.spawnUnit('melee', TEAM_ENEMY, 3, 0)
  world.alertEvents.length = 0
  stepWorld(world, 130) // > 2s: at least one capture check lands
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'enemy holds the shrine')
  const alerts = shrineAlerts(world)
  assertEqual(alerts.length, 1, 'one shrine alert for the one capture')
  assertEqual(alerts[0]?.team, TEAM_PLAYER, 'the alert concerns the losing team')
  assertEqual(alerts[0]?.x, world.positionX[shrine], 'alert x is the shrine')
  assertEqual(alerts[0]?.z, world.positionZ[shrine], 'alert z is the shrine')
})

test('a held shrine pushes nothing on later checks; contested and empty holds stay silent', () => {
  const world = makeWorld()
  const shrine = shrineOf(world)
  const foe = world.spawnUnit('melee', TEAM_ENEMY, 3, 0)
  stepWorld(world, 130)
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'enemy holds it')
  world.alertEvents.length = 0
  stepWorld(world, 180) // three more checks over the unchanged hold
  assertEqual(shrineAlerts(world).length, 0, 'no re-alert while the holder stands')
  // Contest it: the holder keeps it (sticky claim), so no capture event.
  // Both units are frozen in place (6 apart, beyond melee reach) so the
  // contest stays a contest — a duel that killed the holder would be
  // a genuine flip, not a no-event case.
  world.moveSpeed[foe.id] = 0
  const challenger = world.spawnUnit('melee', TEAM_PLAYER, -3, 0)
  world.moveSpeed[challenger.id] = 0
  stepWorld(world, 130)
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'contested: holder keeps it')
  assertEqual(shrineAlerts(world).length, 0, 'a contest is not a capture')
  // Empty it: both units leave, so the claim persists but drains
  // nothing and alerts nothing.
  world.positionX[foe.id] = 30
  world.positionZ[foe.id] = 30
  world.positionX[challenger.id] = 30
  world.positionZ[challenger.id] = -30
  stepWorld(world, 180)
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'empty claim survives')
  assertEqual(shrineAlerts(world).length, 0, 'an empty hold is not a capture')
})

test("the player's own recapture alerts the enemy viewer, not the player", () => {
  const world = makeWorld()
  const shrine = shrineOf(world)
  const foe = world.spawnUnit('melee', TEAM_ENEMY, 3, 0)
  stepWorld(world, 130)
  assertEqual(world.shrineHeld[shrine], TEAM_ENEMY, 'enemy holds it first')
  world.positionX[foe.id] = 30
  world.positionZ[foe.id] = 30
  world.spawnUnit('melee', TEAM_PLAYER, 2, 0)
  world.alertEvents.length = 0
  stepWorld(world, 130)
  assertEqual(world.shrineHeld[shrine], TEAM_PLAYER, 'player retook it')
  const alerts = shrineAlerts(world)
  assertEqual(alerts.length, 1, 'one alert for the one flip')
  assertEqual(alerts[0]?.team, TEAM_ENEMY, 'the loser of this flip is the enemy viewer')
  assert(
    alerts.every((e) => e.team !== TEAM_PLAYER),
    'no player chip for the player’s own good news',
  )
})

test('a queued shrine alert never moves the lockstep hash', () => {
  const world = makeWorld()
  const before = hashWorldState(world)
  world.pushAlert('shrine', 0, 0, TEAM_PLAYER)
  assertEqual(hashWorldState(world), before, 'the visual-only channel is hash-excluded')
  assertEqual(world.alertEvents.length, 1, 'the event is queued for the HUD')
})

// ---------------------------------------------------------------------------
// pickAlert — the display gate (pure)
// ---------------------------------------------------------------------------

suite('basics slice 6: shrine chip priority and cooldown')

const NO_COOLDOWN: Record<AlertKind, number> = {
  attack: -1000000,
  shrine: -1000000,
  treant: -1000000,
  complete: -1000000,
}
const offScreen = (): boolean => false
const ev = (kind: AlertKind, team: 0 | 1 = TEAM_PLAYER): AlertEvent => ({ kind, x: 50, z: 50, team, tick: 0 })

test('priority order is attack > shrine > treant > complete', () => {
  assert(ALERT_PRIORITY.attack > ALERT_PRIORITY.shrine, 'attack outranks shrine')
  assert(ALERT_PRIORITY.shrine > ALERT_PRIORITY.treant, 'shrine outranks treant')
  assert(ALERT_PRIORITY.treant > ALERT_PRIORITY.complete, 'treant still outranks complete')
  assertEqual(
    pickAlert([ev('complete'), ev('treant'), ev('shrine'), ev('attack')], TEAM_PLAYER, null, NO_COOLDOWN, 0, offScreen)?.kind,
    'attack',
    'highest priority wins the empty chip',
  )
  assertEqual(
    pickAlert([ev('complete'), ev('treant'), ev('shrine')], TEAM_PLAYER, null, NO_COOLDOWN, 0, offScreen)?.kind,
    'shrine',
    'shrine beats treant and complete',
  )
})

test('preemption is one-way: shrine replaces treant/complete, never attack', () => {
  const showingTreant = { kind: 'treant' as AlertKind, x: 0, z: 0, shownTick: 0 }
  assertEqual(
    pickAlert([ev('shrine')], TEAM_PLAYER, showingTreant, NO_COOLDOWN, 0, offScreen)?.kind,
    'shrine',
    'shrine preempts a showing treant chip',
  )
  const showingAttack = { kind: 'attack' as AlertKind, x: 0, z: 0, shownTick: 0 }
  assertEqual(
    pickAlert([ev('shrine')], TEAM_PLAYER, showingAttack, NO_COOLDOWN, 0, offScreen),
    null,
    'shrine never preempts a showing attack chip',
  )
})

test('shrine has its own per-class cooldown, independent of attack', () => {
  const shown = { ...NO_COOLDOWN, shrine: 0 }
  assertEqual(
    pickAlert([ev('shrine')], TEAM_PLAYER, null, shown, ALERT_COOLDOWN_TICKS - 1, offScreen),
    null,
    'one tick before the cooldown lapses: still suppressed',
  )
  assertEqual(
    pickAlert([ev('shrine')], TEAM_PLAYER, null, shown, ALERT_COOLDOWN_TICKS, offScreen)?.kind,
    'shrine',
    'at the boundary the class may chip again',
  )
  assertEqual(
    pickAlert([ev('attack')], TEAM_PLAYER, null, shown, 10, offScreen)?.kind,
    'attack',
    'the shrine cooldown does not gate attack',
  )
})

test('shrine chip text names the enemy hold, and the chip has its own style', () => {
  assertEqual(ALERT_TEXT.shrine, '⚑ Enemy holds the shrine!', 'the shipped chip copy')
  const css = readRepoFile('src/style.css')
  assert(css.includes('.hud-alert-shrine'), 'shrine chip styling class exists')
  assert(css.includes('hud-alert-${this.alertChip.kind}') || readRepoFile('src/ui/hud.ts').includes('hud-alert-${this.alertChip.kind}'), 'the chip class is derived from the kind, so shrine picks up its style with no extra wiring')
})
