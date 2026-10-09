import { TEAM_ENEMY, TEAM_PLAYER, World } from './core/World'

/**
 * Minimal deterministic skirmish seed: two finished halls, four workers each,
 * and mirrored resource fields. Starting stock lets both sides train at once.
 */
export function seedScenario(world: World): void {
  world.factionOfTeam = ['human', 'orc']

  // Player base (south-west).
  world.spawnBuilding('hall', TEAM_PLAYER, -40, -40, true)
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_PLAYER, -36 + i * 2, -36)
  }

  // Enemy base (north-east).
  world.spawnBuilding('hall', TEAM_ENEMY, 40, 40, true)
  for (let i = 0; i < 4; i += 1) {
    world.spawnUnit('worker', TEAM_ENEMY, 36 - i * 2, 36)
  }

  // Resource fields near each base.
  for (let i = 0; i < 6; i += 1) world.spawnResource('wood', -52 + i * 3, -18)
  for (let i = 0; i < 3; i += 1) world.spawnResource('gold', 18 + i * 4, -52)
  for (let i = 0; i < 6; i += 1) world.spawnResource('wood', 52 - i * 3, 18)
  for (let i = 0; i < 3; i += 1) world.spawnResource('gold', -18 - i * 4, 52)

  world.gold[TEAM_PLAYER] = 200
  world.wood[TEAM_PLAYER] = 100
  world.gold[TEAM_ENEMY] = 200
  world.wood[TEAM_ENEMY] = 100
}
