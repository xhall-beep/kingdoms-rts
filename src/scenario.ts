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

  // Forests near each base: 6x4 grids (24 trees each).
  for (let gx = 0; gx < 6; gx += 1) {
    for (let gz = 0; gz < 4; gz += 1) {
      world.spawnResource('wood', -58 + gx * 3, -24 + gz * 3)
      world.spawnResource('wood', 58 - gx * 3, 24 - gz * 3)
    }
  }
  // Central contested forest.
  for (let gx = 0; gx < 4; gx += 1) {
    for (let gz = 0; gz < 4; gz += 1) {
      world.spawnResource('wood', -4.5 + gx * 3, -4.5 + gz * 3)
    }
  }
  // Gold mines close to each hall (short walk = real income).
  for (let i = 0; i < 4; i += 1) world.spawnResource('gold', -28 + i * 4, -32)
  for (let i = 0; i < 4; i += 1) world.spawnResource('gold', 28 - i * 4, 32)

  world.gold[TEAM_PLAYER] = 200
  world.wood[TEAM_PLAYER] = 100
  world.gold[TEAM_ENEMY] = 200
  world.wood[TEAM_ENEMY] = 100
}
