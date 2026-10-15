/**
 * AI melee regression — guards the 2026-10-15 melee-starvation fix.
 * The AI used to build a barracks (150g/110w) and then almost never train
 * melee: the 100g melee cost almost never cleared the flat gold-reserve gate
 * while the 80g ranged did (expander: 4 melee vs 49 ranged in 8 minutes, the
 * barracks effectively wasted). The fix softens the reserve for melee
 * (MELEE_RESERVE_FACTOR) and re-prioritizes melee when the barracks sits idle
 * while ranged is affordable (favorMelee + bounded hold).
 * This test counts training onsets externally (no prod-code hooks) over a
 * short deterministic headless mirror.
 */
import { World, KIND_BARRACKS, KIND_ARCHERY, KIND_MELEE, KIND_RANGED } from '../core/World.ts'
import { seedScenario } from '../scenario.ts'
import { MovementSystemImpl } from '../systems/movement.ts'
import { CombatSystemImpl } from '../systems/combat.ts'
import { GatherSystemImpl } from '../systems/gather.ts'
import { ProductionSystemImpl } from '../systems/production.ts'
import { VisionSystemImpl } from '../systems/vision.ts'
import { VictorySystemImpl } from '../systems/victory.ts'
import { OpponentAI, type AIPersonality } from '../ai/opponent.ts'
import { STEP } from './setup.ts'
import { suite, test, assert } from './harness.ts'

suite('ai-melee: barracks produces melee')

/** Count melee/ranged training onsets for team 0 over a headless mirror. */
function countTrained(personality: AIPersonality, minutes: number): { melee: number; ranged: number } {
  const world = new World()
  world.registerSystem(new GatherSystemImpl())
  world.registerSystem(new ProductionSystemImpl())
  world.registerSystem(new CombatSystemImpl())
  world.registerSystem(new VisionSystemImpl())
  world.registerSystem(new VictorySystemImpl())
  world.registerSystem(new MovementSystemImpl())
  world.registerSystem(new OpponentAI(0, 'normal', personality))
  world.registerSystem(new OpponentAI(1, 'normal', personality))
  seedScenario(world, 'human' as never, 'human' as never)

  let melee = 0
  let ranged = 0
  const wasMelee = new Map<number, boolean>()
  const wasRanged = new Map<number, boolean>()
  const maxSteps = 60 * 60 * minutes
  for (let s = 0; s < maxSteps && world.winner === -1; s++) {
    world.update(STEP)
    for (const id of world.entities.keys()) {
      if (world.team[id] !== 0) continue
      const kind = world.kind[id]
      if (kind === KIND_BARRACKS) {
        const training = world.trainKind[id] === KIND_MELEE
        if (training && !wasMelee.get(id)) melee += 1
        wasMelee.set(id, training)
      } else if (kind === KIND_ARCHERY) {
        const training = world.trainKind[id] === KIND_RANGED
        if (training && !wasRanged.get(id)) ranged += 1
        wasRanged.set(id, training)
      }
    }
  }
  return { melee, ranged }
}

test('melee training counts are deterministic', () => {
  const a = countTrained('expander', 5)
  const b = countTrained('expander', 5)
  assert(
    a.melee === b.melee && a.ranged === b.ranged,
    `training counts must be deterministic: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  )
})

test('expander trains a real melee force (no barracks starvation)', () => {
  // Pre-fix the expander trained ~2 melee in 5 minutes (4 in 8); the barracks
  // was a wasted 150g/110w. Post-fix it trains ~9 in the same window.
  const { melee, ranged } = countTrained('expander', 5)
  assert(melee >= 5, `expander starved its barracks: only ${melee} melee trained (ranged ${ranged})`)
  const mix = melee / Math.max(1, melee + ranged)
  assert(mix >= 0.3, `army mix degenerate: melee share ${mix.toFixed(2)} (melee ${melee}, ranged ${ranged})`)
})

test('aggressor and defender also field melee', () => {
  for (const p of ['aggressor', 'defender'] as AIPersonality[]) {
    const { melee } = countTrained(p, 5)
    assert(melee >= 4, `${p} starved its barracks: only ${melee} melee trained in 5 minutes`)
  }
})
