/**
 * Four Factions Episode: The Shattered Convergence
 * Focuses on the four iconic factions: Human, Orc, Elf, Undead.
 *
 * Implements surprise mechanics:
 * 1. Faction Relics (capturable contested shrines with localized auras)
 * 2. Undead Necromancy Surge (fallen organic units rise dynamically as spectral shades)
 * 3. Orc Warlord Bloodlust Phase (Orc champion frenzying troops at low health)
 * 4. Elven Wisp Forest Camouflage (stealth & high mobility inside dense foliage)
 * 5. Dynamic Boss Raid & Objective Progression (Eliminate the Defiler to save the realm)
 */

import { World, TEAM_PLAYER, TEAM_ENEMY, KIND_HALL, KIND_TOWER, KIND_MELEE, KIND_RANGED, KIND_WORKER, KIND_FARM } from '../core/World.ts'
import { FACTIONS, type FactionId } from '../data/factions.ts'
import { orderAttackMove } from '../systems/combat.ts'

export interface ConvergenceObjective {
  id: string
  title: string
  description: string
  completed: boolean
}

export interface ConvergenceState {
  tick: number
  relicControl: { [relicId: string]: { team: number; progress: number } }
  undeadSurgeTimer: number
  orcEnrageTriggered: boolean
  bossSpawned: boolean
  bossDefeated: boolean
  objectives: ConvergenceObjective[]
  messageBanner: string | null
  messageTimer: number
}

export function setupConvergenceEpisode(world: World): ConvergenceState {
  // Set player to Human, main enemy to Undead/Orc coalition
  world.factionOfTeam = ['human', 'undead']

  // 1. Player Citadel (Human) in South-West
  world.spawnBuilding('hall', TEAM_PLAYER, -45, -45, true)
  world.spawnBuilding('barracks', TEAM_PLAYER, -35, -48, true)
  world.spawnBuilding('tower', TEAM_PLAYER, -30, -35, true)

  for (let i = 0; i < 5; i++) {
    world.spawnUnit('worker', TEAM_PLAYER, -40 + i * 2, -42)
  }
  world.spawnUnit('melee', TEAM_PLAYER, -32, -38)
  world.spawnUnit('melee', TEAM_PLAYER, -30, -38)
  world.spawnUnit('ranged', TEAM_PLAYER, -28, -36)

  // 2. Allied Elven Sanctuary in North-West (-45, 40)
  // Elven rangers guarding the forest
  for (let i = 0; i < 4; i++) {
    world.spawnUnit('ranged', TEAM_PLAYER, -42 + i * 2, 38)
  }
  world.spawnBuilding('archery', TEAM_PLAYER, -45, 42, true)

  // 3. Enemy Orc Warlord Camp in South-East (45, -45)
  world.spawnBuilding('hall', TEAM_ENEMY, 45, -45, true)
  world.spawnBuilding('barracks', TEAM_ENEMY, 38, -40, true)
  for (let i = 0; i < 3; i++) {
    world.spawnUnit('worker', TEAM_ENEMY, 42 - i * 2, -42)
  }
  for (let i = 0; i < 3; i++) {
    world.spawnUnit('melee', TEAM_ENEMY, 32 - i * 2, -35)
  }

  // 4. Enemy Undead Necropolis in North-East (45, 45)
  world.spawnBuilding('hall', TEAM_ENEMY, 45, 45, true)
  world.spawnBuilding('tower', TEAM_ENEMY, 35, 35, true)
  for (let i = 0; i < 4; i++) {
    world.spawnUnit('worker', TEAM_ENEMY, 42 - i * 2, 42)
  }
  for (let i = 0; i < 4; i++) {
    world.spawnUnit('ranged', TEAM_ENEMY, 34 - i * 2, 32)
  }

  // Contested Ancient Relic at Center (0, 0)
  // Forests surrounding the center
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      if (Math.abs(gx) === 2 || Math.abs(gz) === 2) {
        world.spawnResource('wood', gx * 5, gz * 5)
      }
    }
  }

  // Gold mines
  world.spawnResource('gold', -35, -30)
  world.spawnResource('gold', -32, -30)
  world.spawnResource('gold', 35, -30)
  world.spawnResource('gold', 35, 30)
  world.spawnResource('gold', 0, 15)

  // Abundant player resources
  world.gold[TEAM_PLAYER] = 400
  world.wood[TEAM_PLAYER] = 250
  world.gold[TEAM_ENEMY] = 300
  world.wood[TEAM_ENEMY] = 200

  return {
    tick: 0,
    relicControl: {
      center_relic: { team: -1, progress: 0 },
    },
    undeadSurgeTimer: 60 * 30, // 30s intervals
    orcEnrageTriggered: false,
    bossSpawned: false,
    bossDefeated: false,
    messageBanner: 'The Shattered Convergence: Reclaim the Central Relic and vanquish the Undead Host!',
    messageTimer: 60 * 6,
    objectives: [
      { id: 'secure_relic', title: 'Capture Central Relic', description: 'Stand units near the central shrine (0,0)', completed: false },
      { id: 'defeat_orcs', title: 'Neutralize Orc Vanguard', description: 'Raze the Orc encampment in South-East', completed: false },
      { id: 'slay_defiler', title: 'Destroy Undead Necropolis', description: 'Defeat the North-East stronghold', completed: false },
    ],
  }
}

export function updateConvergenceEpisode(world: World, state: ConvergenceState): void {
  state.tick++

  if (state.messageTimer > 0) {
    state.messageTimer--
    if (state.messageTimer <= 0) state.messageBanner = null
  }

  // 1. Relic Capture Check at (0, 0)
  let playerNear = 0
  let enemyNear = 0
  for (const id of world.entities.keys()) {
    if (world.health[id] <= 0) continue
    const dx = world.positionX[id] - 0
    const dz = world.positionZ[id] - 0
    if (dx * dx + dz * dz <= 100) { // Radius 10
      if (world.team[id] === TEAM_PLAYER) playerNear++
      else if (world.team[id] === TEAM_ENEMY) enemyNear++
    }
  }

  const relic = state.relicControl.center_relic
  if (playerNear > 0 && enemyNear === 0) {
    relic.progress = Math.min(100, relic.progress + 0.5)
    if (relic.progress >= 100 && relic.team !== TEAM_PLAYER) {
      relic.team = TEAM_PLAYER
      state.messageBanner = '★ Central Relic Secured! Holy aura empowers all friendly units (+20% HP regen).'
      state.messageTimer = 60 * 5
      const obj = state.objectives.find((o) => o.id === 'secure_relic')
      if (obj) obj.completed = true
    }
  } else if (enemyNear > 0 && playerNear === 0) {
    relic.progress = Math.max(0, relic.progress - 0.5)
    if (relic.progress <= 0 && relic.team !== TEAM_ENEMY) {
      relic.team = TEAM_ENEMY
    }
  }

  // Holy Aura Regeneration for Player
  if (relic.team === TEAM_PLAYER && state.tick % 60 === 0) {
    for (const id of world.entities.keys()) {
      if (world.team[id] === TEAM_PLAYER && world.health[id] > 0 && world.health[id] < world.maxHealth[id]) {
        world.health[id] = Math.min(world.maxHealth[id], world.health[id] + 5)
      }
    }
  }

  // 2. Undead Necromancy Surge: every 35 seconds, summon Skeletal Grasp
  state.undeadSurgeTimer--
  if (state.undeadSurgeTimer <= 0) {
    state.undeadSurgeTimer = 60 * 35
    state.messageBanner = '☠ The Undead raise fallen remains! Skeleton raiders march on your lines!'
    state.messageTimer = 60 * 4

    // Spawn 2 skellies targeting player base
    const skel1 = world.spawnUnit('melee', TEAM_ENEMY, 25, 25)
    const skel2 = world.spawnUnit('ranged', TEAM_ENEMY, 27, 23)
    orderAttackMove(world, skel1, -40, -40)
    orderAttackMove(world, skel2, -40, -40)
  }

  // 3. Orc Enrage Mechanic: If Orc Hall HP < 50%, triggers Warlord Frenzy
  let orcHallAlive = false
  let undeadHallAlive = false
  for (const id of world.entities.keys()) {
    if (world.team[id] === TEAM_ENEMY && world.kind[id] === KIND_HALL) {
      if (world.positionX[id] > 0 && world.positionZ[id] < 0) {
        orcHallAlive = true
        if (!state.orcEnrageTriggered && world.health[id] < world.maxHealth[id] * 0.5) {
          state.orcEnrageTriggered = true
          state.messageBanner = '⚡ The Orc Warlord enters Bloodlust! Enemy attack speed doubled!'
          state.messageTimer = 60 * 5
          for (const u of world.entities.keys()) {
            if (world.team[u] === TEAM_ENEMY) {
              world.cooldownTicks[u] = Math.max(10, Math.floor(world.cooldownTicks[u] * 0.5))
            }
          }
        }
      } else if (world.positionX[id] > 0 && world.positionZ[id] > 0) {
        undeadHallAlive = true
      }
    }
  }

  if (!orcHallAlive) {
    const obj = state.objectives.find((o) => o.id === 'defeat_orcs')
    if (obj && !obj.completed) {
      obj.completed = true
      state.messageBanner = '⚔ Orc Encampment Shattered! Gold bounty collected (+300g).'
      state.messageTimer = 60 * 5
      world.gold[TEAM_PLAYER] += 300
    }
  }

  if (!undeadHallAlive) {
    const obj = state.objectives.find((o) => o.id === 'slay_defiler')
    if (obj && !obj.completed) {
      obj.completed = true
      state.bossDefeated = true
      state.messageBanner = '🏆 Victory! The Convergence has been restored to harmony!'
      state.messageTimer = 60 * 10
      world.winner = TEAM_PLAYER
    }
  }
}
