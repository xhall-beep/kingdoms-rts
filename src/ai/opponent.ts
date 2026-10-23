import { BUILDINGS } from '../data/buildings.ts'
import { getUnits } from '../data/stats.ts'
import type { System, World } from '../core/World'
import {
  HARVEST_ANY,
  HARVEST_GOLD,
  HARVEST_WOOD,
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_WORKER,
  NO_TARGET,
  NO_TRAINING,
  STATE_IDLE,
  STATE_BUILD,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  KIND_GOLDMINE,
  KIND_SHRINE,
  KIND_TREE} from '../core/World'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { orderAttackMove } from '../systems/combat.ts'
import { orderMove } from '../systems/movement.ts'
import { CAPTURE_RADIUS } from '../systems/shrines.ts'
import { enqueueTrain, researchUpgrade, upgradeBuilding } from '../systems/production.ts'
import { UPGRADES, type UpgradeType } from '../data/upgrades.ts'
import {
  BUILDING_TYPE_BY_KIND,
  placeStructure,
} from '../world/construction.ts'
import { canSee, isExplored } from '../world/visibility.ts'
import type { BuildingType } from '../data/buildings.ts'
import type { UnitType } from '../data/units.ts'
import type { Command } from '../session/commands.ts'

/**
 * Command sink for lockstep PvP-vs-AI mode. When set, the AI emits Command
 * objects instead of mutating the world directly, so its orders flow through
 * the lockstep turn system exactly like a remote human player's commands.
 * When unset, the AI mutates directly (single-player/campaign mode).
 */
export type CommandSink = (cmd: Command) => void

const WOOD_SHARE = 0.4 // Fraction of workers assigned to wood (the rest mine gold).

/**
 * The barracks' melee (100g) costs 20g more than the archery's ranged (80g),
 * so a flat gold-reserve gate starves melee even while the barracks sits
 * idle. Melee trains against this fraction of the planned-building reserve.
 */
const MELEE_RESERVE_FACTOR = 0.5
/**
 * Max think ticks a melee re-prioritization hold lasts before it yields back
 * to ranged (safety valve so the archery can never stall permanently).
 */
const MELEE_STARVE_HOLD_WINDOW = 10

/**
 * Nearest harvestable node of the wanted type to a worker. Deterministic:
 * ties break by lower entity id. Returns -1 when no node of that kind exists.
 */
function nearestResourceNode(world: World, workerId: number, wantWood: boolean): number {
  const wantKind = wantWood ? KIND_TREE : KIND_GOLDMINE
  const wx = world.positionX[workerId]
  const wz = world.positionZ[workerId]
  let best = -1
  let bestD = Infinity
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== wantKind) continue
    if (world.amount[id] <= 0) continue
    const d = Math.hypot(world.positionX[id] - wx, world.positionZ[id] - wz)
    if (d < bestD || (d === bestD && id < best)) {
      bestD = d
      best = id
    }
  }
  return best
}

const FLEE_TRIGGER = 32 // A worker evacuates when a visible enemy is this close.
const FLEE_STANDOFF = 16 // Rally distance behind the hall, away from the threat.
/**
 * Battle micro: each engaged soldier compares local strength (its own side's
 * health within MICRO_RADIUS vs the visible enemy's) and pulls back to the
 * hall when outmatched. Deterministic: pure world-state evaluation, no RNG.
 */
const MICRO_RADIUS = 18 // Local fight window for the strength comparison.
const WOUNDED_FRACTION = 0.3 // Below this health fraction a soldier withdraws.
/**
 * Retreat trigger: enemyLocal > ownLocal * ratio orders a pullback.
 * The aggressor fights on until the fight is hopeless; the defender
 * preserves its army first. The aggressor also never withdraws wounded —
 * it holds the line while it still stands.
 */
const RETREAT_RATIO: Record<AIPersonality, number> = {
  aggressor: 3.0,
  expander: 1.75,
  defender: 1.35,
}
const MAP_CLAMP = 56 // Keep flee destinations on the playable map.

/**
 * Undead supply discipline: undead raise no farms — their supply cap grows
 * only through Soul-Ash from the fallen. Filling the whole cap with workers
 * leaves no room for a single soldier, and soldiers are what make corpses:
 * the documented supply trap (audit 2026-10-22). An undead AI therefore
 * holds this much supply in reserve for an army; as ash raises the cap,
 * the effective worker target rises with it.
 */
const UNDEAD_ARMY_SUPPLY_RESERVE = 4

/**
 * Undead attack discipline: the shared attack thresholds (5–9 soldiers
 * beyond the garrison) are calibrated for farm economies, which grow by
 * building and can simply wait until the army is ready. Undead grows only
 * through corpses, so a threshold it cannot reach before first combat is
 * a death sentence: the farm-grown rival always dictates the first fight,
 * at undead's base, on the rival's schedule (army-ceiling audit
 * 2026-10-22 — 0 offensive waves measured). Undead therefore marches on
 * a materially smaller force: its soldiers are cheap, fast-trained, and
 * a quarter of its dead rise again. And until the first corpse lands
 * (Soul-Ash still zero) it waives the home garrison entirely — see
 * attack(). Every other faction's attack behavior is unchanged.
 */
const UNDEAD_ATTACK_ARMY = 3

/** Muster radius of the Militia Bell — mirrors World.ringMilitiaBell. */
const MILITIA_MUSTER_RADIUS = 25

/**
 * AI research discipline: the upgrade ladder was only ever driven from
 * the player UI, so in AI-vs-AI every faction's research sat dark —
 * including human's Adaptable discount, its signature (orc-human audit
 * 2026-10-22). The AI buys the next level only from a genuine surplus:
 * the army it would upgrade already stands (soldiers >= its attack
 * threshold) and the bank clears this floor. The floor is the orc
 * foundry-tier line itself: researchUpgrades runs AFTER
 * upgradeOrcBuildings in the think order, so tiers keep first claim on
 * any bank at their >=400 gate, and since researching only ever spends
 * gold, it can delay a tier — never trigger one. An earlier draft of
 * this step (floor 250, no army precondition) taxed every faction's
 * opening and halved undead's 5:00 peak army in the cold-start pins —
 * the surplus gates are what keep research a mid-game lever.
 */
const RESEARCH_GOLD_FLOOR = 400
/** Melee first: winners' armies run ~58% melee, so its ladder pays most. */
const RESEARCH_ORDER: readonly UpgradeType[] = ['meleeDmg', 'meleeHp', 'rangedDmg']

export type AIDifficulty = 'easy' | 'normal' | 'hard'

/** Resolved decision parameters: difficulty base values plus personality mods. */
export interface AIDecisionTuning {
  thinkEvery: number // seconds between decisions
  workerTarget: number
  workersBeforeArmy: number // economy first: no military buildings before this many workers
  attackArmy: number // soldiers needed before attacking
  defenseRadius: number // enemies this close to the hall pull the army home
  expansionAtSec: number // seconds before a second town hall is considered (Infinity = never)
}

/**
 * Difficulty handicaps. The AI always plays by the rules (same commands, costs
 * and build times as the player); difficulty only changes how fast and how
 * ambitiously it makes decisions.
 */
const DIFFICULTY: Record<AIDifficulty, AIDecisionTuning> = {
  easy: { thinkEvery: 2.0, workerTarget: 7, workersBeforeArmy: 6, attackArmy: 8, defenseRadius: 20, expansionAtSec: 300 },
  normal: { thinkEvery: 1.0, workerTarget: 10, workersBeforeArmy: 5, attackArmy: 5, defenseRadius: 28, expansionAtSec: 300 },
  hard: { thinkEvery: 0.5, workerTarget: 12, workersBeforeArmy: 4, attackArmy: 4, defenseRadius: 36, expansionAtSec: 300 },
}

interface PersonalityMods {
  thinkEveryMult: number
  workerTargetDelta: number
  workersBeforeArmyDelta: number
  attackArmyDelta: number
  defenseRadiusDelta: number
  expansionAtSec: number // absolute override
}

/**
 * How each personality bends the difficulty base. The aggressor rushes with a
 * smaller force and never expands; the defender turtles and only leaves with
 * a real army; the expander booms the economy and grabs a second hall early.
 */
const PERSONALITY_MODS: Record<AIPersonality, PersonalityMods> = {
  aggressor: { thinkEveryMult: 0.8, workerTargetDelta: -1, workersBeforeArmyDelta: -2, attackArmyDelta: 1, defenseRadiusDelta: -10, expansionAtSec: Infinity },
  defender: { thinkEveryMult: 1.0, workerTargetDelta: 0, workersBeforeArmyDelta: 1, attackArmyDelta: 4, defenseRadiusDelta: 12, expansionAtSec: 420 },
  expander: { thinkEveryMult: 1.0, workerTargetDelta: 2, workersBeforeArmyDelta: 0, attackArmyDelta: 1, defenseRadiusDelta: 0, expansionAtSec: 180 },
}

/**
 * Built-in opponent. It plays by the rules: every action goes through the same
 * commands as player input, so it can never cheat past costs or build times.
 * Deterministic: no randomness anywhere.
 *
 * Fog of war: it defends against enemy units it can currently SEE near its hall,
 * and only attacks the enemy hall once it has explored that spot. Until then it
 * marches toward the mirror of its own hall, then searches the map.
 */
export type AIPersonality = 'aggressor' | 'defender' | 'expander'

export class OpponentAI implements System {
  private readonly team: 0 | 1
  private readonly tuning: AIDecisionTuning
  readonly difficulty: AIDifficulty
  readonly personality: AIPersonality
  private timer = 0
  private gameTime = 0 // seconds elapsed
  /** Countdown while ranged production is held so an idle barracks gets its
   * melee (see trainSoldiers). Deterministic: derived from think ticks. */
  private meleeHoldTicks = 0
  /** Alternation flag: when true, the next contested gold goes to melee. */
  private favorMelee = true
  private scoutId: number | null = null
  private scoutTargets: { x: number; z: number }[] = []
  /** Workers currently evacuated from a raid. They are not reassigned to
   * gather or construction duty until the threat is gone. */
  private readonly fleeing = new Set<number>()
  /** When set, AI decisions are emitted as Commands (PvP-vs-AI lockstep mode). */
  private sink: CommandSink | null = null

  constructor(team: 0 | 1, difficulty: AIDifficulty = 'normal', personality: AIPersonality = 'expander') {
    this.team = team
    this.difficulty = difficulty
    this.personality = personality
    const base = DIFFICULTY[difficulty]
    const mods = PERSONALITY_MODS[personality]
    this.tuning = {
      thinkEvery: base.thinkEvery * mods.thinkEveryMult,
      workerTarget: Math.max(3, base.workerTarget + mods.workerTargetDelta),
      workersBeforeArmy: Math.max(2, base.workersBeforeArmy + mods.workersBeforeArmyDelta),
      attackArmy: Math.max(2, base.attackArmy + mods.attackArmyDelta),
      defenseRadius: Math.max(10, base.defenseRadius + mods.defenseRadiusDelta),
      expansionAtSec: mods.expansionAtSec,
    }
  }

  /** Resolved decision parameters (difficulty + personality), for tests and UI. */
  decisionTuning(): AIDecisionTuning {
    return { ...this.tuning }
  }

  /**
   * Enable lockstep command-emission mode. The AI will emit Command objects
   * to the sink instead of mutating the world. Pass null to restore direct
   * mutation (single-player mode).
   */
  setCommandSink(sink: CommandSink | null): void {
    this.sink = sink
  }

  // -- Command-emission helpers (sink mode) vs direct mutation (default) --

  private emitMove(world: World, id: number, x: number, z: number): void {
    if (this.sink) {
      this.sink({ type: 'move', step: 0, unitIds: [id], x, z })
    } else {
      orderMove(world, id, x, z)
    }
  }

  private emitAttackMove(world: World, id: number, x: number, z: number): void {
    if (this.sink) {
      this.sink({ type: 'attackmove', step: 0, unitIds: [id], x, z })
    } else {
      orderAttackMove(world, id, x, z)
    }
  }

  private emitGather(world: World, id: number, wantWood: boolean): void {
    if (this.sink) {
      const node = nearestResourceNode(world, id, wantWood)
      if (node !== -1) {
        this.sink({ type: 'gather', step: 0, unitIds: [id], nodeId: node })
      }
      // No valid node: skip (worker stays idle this think cycle).
    } else {
      world.harvestKind[id] = wantWood ? HARVEST_WOOD : HARVEST_GOLD
      orderGather(world, id)
    }
  }

  private emitBuild(world: World, workerId: number, building: BuildingType, x: number, z: number): void {
    if (this.sink) {
      // applyCommand re-runs placement deterministically on both peers.
      this.sink({ type: 'build', step: 0, workerId, building, x, z, siteId: 0 })
    } else {
      const placed = placeStructure(world, this.team, building, x, z)
      if (placed.ok) orderBuild(world, workerId, placed.id)
    }
  }

  private emitTrain(world: World, buildingId: number, unit: UnitType): void {
    if (this.sink) {
      this.sink({ type: 'train', step: 0, buildingId, unit })
    } else {
      enqueueTrain(world, buildingId, unit)
    }
  }

  update(world: World, dt: number): void {
    this.timer += dt
    this.gameTime += dt
    if (this.timer < this.tuning.thinkEvery) return
    this.timer = 0

    const team = this.team
    const hall = structuresOf(world, team, KIND_HALL, true)[0]
    if (hall === undefined) return // Defeated.

    const workers = unitsOf(world, team, KIND_WORKER)
    const soldiers = [...unitsOf(world, team, KIND_MELEE), ...unitsOf(world, team, KIND_RANGED)]

    this.trainWorkers(world, hall, workers.length)
    this.evacuateWorkers(world, hall, workers)
    this.assignWorkers(world, workers)
    this.scout(world, hall, workers)
    this.expandBase(world, hall, workers)
    const reserveGold = this.expand(world, hall, workers)
    this.resumeStalledBuilds(world, workers)
    this.upgradeOrcBuildings(world, hall)
    this.researchUpgrades(world)
    this.contestShrine(world, soldiers)
    this.trainSoldiers(world, workers.length, reserveGold)
    if (!this.defend(world, hall, soldiers)) this.attack(world, hall, soldiers)
    this.microArmy(world, hall, soldiers)
  }

  /**
   * Shrine contest: if the shrine isn't held by us and we have troops to
   * spare beyond the army the personality wants to attack with, send a small
   * party to take it. Never splits the main army — Victory Points punish
   * turtling, not disciplined force concentration.
   *
   * Exception — the emergency answer: while an enemy holder keeps a unit
   * on the point, our VP drains every second, so any idle soldier beyond
   * the garrison marches to contest it, attack threshold be damned.
   */
  private contestShrine(world: World, soldiers: number[]): void {
    let shrine = -1
    for (const id of world.entities.keys()) {
      if (world.kind[id] === KIND_SHRINE) {
        shrine = id
        break
      }
    }
    if (shrine === -1 || world.shrineHeld[shrine] === this.team) return
    const idle = soldiers.filter(
      (id) => world.state[id] === STATE_IDLE && !this.fleeing.has(id),
    )
    if (idle.length === 0) return

    // Emergency answer: the enemy holds the shrine AND keeps a living
    // unit inside the radius, so our Victory Points are bleeding 5/s
    // right now. The normal contest below waits for an idle surplus the
    // early game never produces — while the drain ran presence-free that
    // meant certain death before any answer could exist (shrine audit
    // 2026-10-22: the VP kill landed ~37s before the loser's first wave
    // even arrived). Under presence-sustained drain the bleeding can be
    // stopped by force: march whatever stands beyond the garrison to
    // the point and make the holder fight for its upkeep.
    const holder = world.shrineHeld[shrine]
    if (holder !== -1 && this.shrinePresence(world, shrine, holder) > 0) {
      const available = idle.length - this.garrisonFor(world)
      if (available < 1) return
      const party = idle.slice(0, Math.min(3, available))
      for (const id of party) {
        this.emitAttackMove(world, id, world.positionX[shrine], world.positionZ[shrine])
      }
      return
    }

    const surplus = idle.length - this.attackThreshold(world)
    if (surplus < 3) return
    const party = idle.slice(0, 3)
    for (const id of party) {
      this.emitAttackMove(world, id, world.positionX[shrine], world.positionZ[shrine])
    }
  }

  /** Living military units of `team` inside the shrine's capture radius
   * (the same presence definition the shrine system drains on). */
  private shrinePresence(world: World, shrine: number, team: number): number {
    const sx = world.positionX[shrine]
    const sz = world.positionZ[shrine]
    let count = 0
    for (const id of world.entities.keys()) {
      if (world.team[id] !== team || world.health[id] <= 0) continue
      const k = world.kind[id]
      if (k !== KIND_MELEE && k !== KIND_RANGED && k !== KIND_WORKER) continue
      const dx = world.positionX[id] - sx
      const dz = world.positionZ[id] - sz
      if (dx * dx + dz * dz <= CAPTURE_RADIUS * CAPTURE_RADIUS) count += 1
    }
    return count
  }

  /** Home garrison this AI keeps back right now. Undead waive it entirely
   * until the first corpse feeds Soul-Ash — a garrison guarding a cap that
   * cannot grow only delays the combat its economy runs on (see attack()). */
  private garrisonFor(world: World): number {
    const isUndead = world.factionOfTeam[this.team] === 'undead'
    return isUndead && world.soulAsh[this.team] === 0 ? 0 : this.getGarrisonSize()
  }

  /**
   * Orc racial: reforge the War-Hall and Foundries through the tiers when the
   * war chest allows. Runs before trainSoldiers so upgrades compete honestly
   * with unit production for the same gold.
   */
  private upgradeOrcBuildings(world: World, hall: number): void {
    if (world.factionOfTeam[this.team] !== 'orc') return
    // Only once the economy is rolling: keep an early-game reserve.
    if (world.gold[this.team] < 400) return
    if (upgradeBuilding(world, hall)) return
    for (const id of world.entities.keys()) {
      if (world.team[id] !== this.team || world.kind[id] !== KIND_BARRACKS) continue
      if (upgradeBuilding(world, id)) return
    }
  }

  /**
   * AI research step (all factions). Buys at most one level per think
   * tick: the first ladder below max whose own building (barracks for
   * melee, archery for ranged — per UPGRADES) stands finished, whose
   * cost the bank covers, and only once the standing army meets the
   * attack threshold (see RESEARCH_GOLD_FLOOR). researchUpgrade applies
   * the faction factor
   * itself, so human's Adaptable discount (0.8x) differentiates human
   * exactly the way orc's foundry tiers differentiate orc.
   *
   * Lockstep: applied directly, exactly like the AI's orc tier upgrades
   * (upgradeBuilding in upgradeOrcBuildings). There is no 'research'
   * Command type — adding one would change the PvP wire protocol — and
   * the AI joins lockstep only in single-world practice mode, where a
   * deterministic direct mutation cannot diverge between peers (real
   * PvP fields no AI). The levels are hashed world state (net/hash.ts).
   */
  private researchUpgrades(world: World): void {
    if (world.gold[this.team] < RESEARCH_GOLD_FLOOR) return
    // Upgrade the army you have: no standing army, no research. This
    // keeps the opening ramp (where gold converts straight into
    // soldiers every think) untaxed.
    const soldiers =
      unitsOf(world, this.team, KIND_MELEE).length +
      unitsOf(world, this.team, KIND_RANGED).length
    if (soldiers < this.attackThreshold(world)) return
    for (const type of RESEARCH_ORDER) {
      const def = UPGRADES[type]
      const level =
        type === 'meleeDmg'
          ? world.meleeDmgLvl[this.team]
          : type === 'meleeHp'
            ? world.meleeHpLvl[this.team]
            : world.rangedDmgLvl[this.team]
      if (level >= def.maxLevel) continue
      const kind = def.building === 'barracks' ? KIND_BARRACKS : KIND_ARCHERY
      const building = structuresOf(world, this.team, kind, true)[0]
      if (building === undefined) continue
      researchUpgrade(world, building, type)
      return // One level per think tick, bought or not — no cascade.
    }
  }

  private trainWorkers(world: World, hall: number, workerCount: number): void {
    const queued = world.trainKind[hall] !== NO_TRAINING ? 1 : 0 // Single training slot.
    let target = this.tuning.workerTarget
    if (world.factionOfTeam[this.team] === 'undead') {
      // No farms: never let workers consume the entire supply cap (see
      // UNDEAD_ARMY_SUPPLY_RESERVE). Other factions are unaffected.
      target = Math.min(
        target,
        Math.max(0, world.supplyCap[this.team] - UNDEAD_ARMY_SUPPLY_RESERVE),
      )
    }
    if (workerCount + queued < target) this.emitTrain(world, hall, 'worker')
  }

  /**
   * Workers harvest, keeping roughly WOOD_SHARE on wood. Workers the gather
   * system auto-assigned (HARVEST_ANY) are converted proactively: waiting for
   * them to go IDLE first loses the race to the gather system every tick and
   * leaves the economy hypersensitive to spawn geometry.
   */
  /**
   * Worker micro: when a visible enemy is inside the base, workers near the
   * threat evacuate behind the hall instead of harvesting through the raid.
   * Evacuated workers stay out of the gather rotation (and off construction
   * duty) until the threat is gone, then the normal rotation re-arms them.
   * Deterministic: same visible state always yields the same orders.
   */
  private evacuateWorkers(world: World, hall: number, workers: number[]): void {
    // Prune workers that died while evacuated.
    for (const id of this.fleeing) {
      if (!world.entities.has(id)) this.fleeing.delete(id)
    }
    const threat = this.nearestVisibleThreat(world, hall)
    if (threat === NO_TARGET) {
      this.fleeing.clear()
      return
    }
    const dest = this.fleeDestination(world, hall, threat)
    for (const id of workers) {
      if (id === this.scoutId) continue // The scout keeps its mission.
      // A worker mid-construction stays on the site: yanking it abandons the
      // structure, and a raid scare is not worth a permanently stalled
      // barracks (the supervisor below re-arms genuine losses, but avoiding
      // the churn keeps the build on schedule).
      if (world.state[id] === STATE_BUILD) continue
      if (!world.entities.has(id) || world.health[id] <= 0) continue
      const d = Math.hypot(
        world.positionX[id] - world.positionX[threat],
        world.positionZ[id] - world.positionZ[threat],
      )
      if (d < FLEE_TRIGGER) {
        this.emitMove(world, id, dest.x, dest.z)
        this.fleeing.add(id)
      }
    }
  }

  /** Rally point: behind the hall on the far side of the threat. */
  private fleeDestination(world: World, hall: number, threat: number): { x: number; z: number } {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    let dx = hx - world.positionX[threat]
    let dz = hz - world.positionZ[threat]
    const d = Math.hypot(dx, dz)
    if (d < 1e-6) {
      dx = 1
      dz = 0
    } else {
      dx /= d
      dz /= d
    }
    const clamp = (v: number): number => Math.max(-MAP_CLAMP, Math.min(MAP_CLAMP, v))
    return { x: clamp(hx + dx * FLEE_STANDOFF), z: clamp(hz + dz * FLEE_STANDOFF) }
  }

  /**
   * Nearest enemy unit the AI can currently see inside its defense radius.
   * Deterministic: ties break on the spatial hash sequence number.
   */
  private nearestVisibleThreat(world: World, hall: number): number {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const hash = world.spatialHash
    let threat = NO_TARGET
    let nearest = this.tuning.defenseRadius
    let bestSeq = Number.MAX_SAFE_INTEGER
    // defenseRadius (20-28) fits in the hash 3x3; fall back to full scan if larger.
    const consider = (id: number) => {
      const kind = world.kind[id]
      if (kind !== KIND_WORKER && kind !== KIND_MELEE && kind !== KIND_RANGED) return
      if (world.team[id] === this.team) return
      if (!canSee(world, this.team, id)) return
      const d = Math.hypot(world.positionX[id] - hx, world.positionZ[id] - hz)
      const seq = hash.sequenceOf(id)
      if (d < nearest || (d === nearest && seq < bestSeq)) {
        nearest = d
        bestSeq = seq
        threat = id
      }
    }
    // Spatial hash rect query covers the defense circle exactly (any radius).
    const r = this.tuning.defenseRadius
    hash.forEachInRect(hx - r, hz - r, hx + r, hz + r, consider)
    return threat
  }

  private assignWorkers(world: World, workers: number[]): void {
    let onWood = 0
    for (const id of workers) {
      if (world.harvestKind[id] === HARVEST_WOOD) onWood += 1
    }
    const woodWanted = Math.ceil(workers.length * WOOD_SHARE)
    for (const id of workers) {
      if (this.fleeing.has(id)) continue // Evacuated: stays out until the raid ends.
      const needsAssignment =
        world.state[id] === STATE_IDLE || world.harvestKind[id] === HARVEST_ANY
      if (!needsAssignment) continue
      const wantWood = onWood < woodWanted
      if (wantWood) {
        onWood += 1
      }
      if (!this.sink) {
        world.harvestKind[id] = wantWood ? HARVEST_WOOD : HARVEST_GOLD
      }
      this.emitGather(world, id, wantWood)
    }
  }

  /**
   * At most one new structure per decision, in priority order.
   * Returns the gold cost to reserve from soldier training while saving
   * for the planned building (0 when nothing is planned).
   */
  /** Build a second Town Hall near untapped resources when the main base depletes. */
  private expandBase(world: World, _hall: number, workers: number[]): void {
    // Personality decides when (or whether) to expand at all.
    if (this.gameTime < this.tuning.expansionAtSec) return
    const halls = structuresOf(world, this.team, KIND_HALL, true)
    if (halls.length >= 2) return // Already expanded
    if (world.gold[this.team] < 400) return // Need savings for the hall

    // Find a gold mine far from our existing halls
    let best: number | null = null
    let bestDist = 60 // Minimum distance from existing halls
    for (const id of world.entities.keys()) {
      if (world.kind[id] !== KIND_GOLDMINE) continue
      if (world.amount[id] < 500) continue // Need a rich node
      let minHallDist = Infinity
      for (const h of halls) {
        const d = Math.hypot(world.positionX[id] - world.positionX[h], world.positionZ[id] - world.positionZ[h])
        minHallDist = Math.min(minHallDist, d)
      }
      if (minHallDist > bestDist) {
        bestDist = minHallDist
        best = id
      }
    }

    if (best !== null) {
      // Send a worker to build a hall near this gold mine
      const gx = world.positionX[best]
      const gz = world.positionZ[best]
      const worker = workers.find((id) => world.state[id] === STATE_IDLE && !this.fleeing.has(id))
      if (worker !== undefined) {
        this.emitBuild(world, worker, 'hall', gx + 10, gz + 10)
      }
    }
  }

  /** Send a worker to scout the map and find the enemy base. */
  private scout(world: World, hall: number, workers: number[]): void {
    // Only scout early game, and only if we don't know where the enemy is
    if (this.gameTime > 180) return // Stop scouting after 3 minutes
    const enemyTeam = (this.team === 0 ? 1 : 0) as 0 | 1
    const enemyHall = structuresOf(world, enemyTeam, KIND_HALL, false)[0]
    if (enemyHall !== undefined) {
      const ex = world.positionX[enemyHall]
      const ez = world.positionZ[enemyHall]
      if (isExplored(world, this.team, ex, ez)) return // Already found them
    }

    // Check if our scout is still alive and scouting
    if (this.scoutId !== null) {
      if (!world.entities.has(this.scoutId) || world.health[this.scoutId] <= 0) {
        this.scoutId = null
      } else if (world.state[this.scoutId] === STATE_IDLE && this.scoutTargets.length > 0) {
        // Scout arrived, send to next target
        const t = this.scoutTargets.shift()!
        this.emitMove(world, this.scoutId, t.x, t.z)
        return
      } else if (world.state[this.scoutId] !== STATE_IDLE) {
        return // Still moving
      }
    }

    // Need a new scout
    if (this.scoutId === null && workers.length >= 3 && this.scoutTargets.length === 0) {
      // Generate scout targets (map corners and center)
      const hx = world.positionX[hall]
      const hz = world.positionZ[hall]
      // Scout away from our base
      this.scoutTargets = [
        { x: -hx, z: -hz }, // Mirror position (likely enemy base)
        { x: -hx * 0.5, z: hz * 0.5 },
        { x: hx * 0.5, z: -hz * 0.5 },
      ]
      // Pick a worker: prefer an idle one, else pull one off harvesting. The
      // gather system grabs idle workers before our think tick, so waiting
      // for an idle worker means scouting never happens. An explicit move
      // order sets the worker to HARVEST_OFF; it goes back to work when done.
      // Evacuated workers stay at their rally point.
      const candidates = workers.filter((id) => !this.fleeing.has(id))
      const scout =
        candidates.find((id) => world.state[id] === STATE_IDLE) ??
        candidates.find((id) => world.carryAmount[id] === 0) ??
        candidates[0]
      if (scout === undefined) {
        this.scoutTargets = [] // Everyone is evacuating; retry next think.
        return
      }
      this.scoutId = scout
      const t = this.scoutTargets.shift()!
      this.emitMove(world, scout, t.x, t.z)
    }
  }

  private expand(world: World, hall: number, workers: number[]): number {
    const team = this.team
    const all = (kind: number): number => structuresOf(world, team, kind, false).length
    const pending = (kind: number): number => all(kind) - structuresOf(world, team, kind, true).length
    const slack = world.supplyCap[team] - world.supplyUsed[team]
    const ready = workers.length >= this.tuning.workersBeforeArmy

    // Priority order. Farms only jump the queue when population is truly blocked,
    // otherwise cheap farms would starve the military buildings forever.
    // Undead raise no farms — Soul-Ash from the fallen feeds their supply cap.
    const needsFarms = world.factionOfTeam[team] !== 'undead'
    let want: number | null = null
    if (ready && all(KIND_BARRACKS) === 0) want = KIND_BARRACKS
    else if (needsFarms && slack <= 1 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && all(KIND_ARCHERY) === 0) want = KIND_ARCHERY
    else if (needsFarms && slack <= 3 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && world.gold[team] >= 400 && all(KIND_BARRACKS) < 2 && pending(KIND_BARRACKS) === 0) {
      want = KIND_BARRACKS
    }
    if (want === null) return 0
    const type = BUILDING_TYPE_BY_KIND[want]
    this.build(world, hall, want, workers)
    return BUILDINGS[type].cost.gold
  }

  /** Place a structure in a free spot around the hall and send a worker to build it. */
  private build(world: World, hall: number, kind: number, workers: number[]): boolean {
    const type = BUILDING_TYPE_BY_KIND[kind]
    const def = BUILDINGS[type]
    if (world.gold[this.team] < def.cost.gold || world.wood[this.team] < def.cost.wood) {
      return true // Saving up; try again once affordable.
    }
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const ringBase = BUILDINGS.hall.radius + def.radius + 3
    for (let k = 0; k < 30; k += 1) {
      const ring = Math.floor(k / 10)
      const angle = (k % 10) * 0.628 + ring * 0.3
      const r = ringBase + ring * 4
      const bx = hx + Math.cos(angle) * r
      const bz = hz + Math.sin(angle) * r
      const builder =
        workers.find((id) => world.state[id] === STATE_IDLE && !this.fleeing.has(id)) ??
        workers.find((id) => world.carryAmount[id] === 0 && !this.fleeing.has(id))
      if (this.sink) {
        // Lockstep mode: emit for the first candidate spot; applyCommand
        // validates placement deterministically on both peers.
        if (builder !== undefined) this.emitBuild(world, builder, type, bx, bz)
        return false
      }
      const placed = placeStructure(world, this.team, type, bx, bz)
      if (placed.ok) {
        if (builder !== undefined) orderBuild(world, builder, placed.id)
        return false
      }
    }
    return false // No free spot; try again next decision.
  }

  /**
   * Re-assign a builder to any structure stalled with nobody on it. A builder
   * yanked off a site (raid evacuation, death) orphans it: the half-built
   * husk still counts toward the build plan, so the AI never retries and the
   * sunk cost never completes. Each think tick re-arms one idle worker per
   * stalled site. Deterministic: entity-id order, first idle non-evacuated
   * worker wins.
   */
  private resumeStalledBuilds(world: World, workers: number[]): void {
    for (const id of world.entities.keys()) {
      if (world.team[id] !== this.team) continue
      const kind = world.kind[id]
      if (kind < KIND_HALL || kind > KIND_FARM) continue
      if (world.buildProgress[id] >= world.buildTotal[id]) continue
      let hasBuilder = false
      for (const w of workers) {
        if (world.state[w] === STATE_BUILD && world.targetId[w] === id) {
          hasBuilder = true
          break
        }
      }
      if (hasBuilder) continue
      const builder =
        workers.find((w) => world.state[w] === STATE_IDLE && !this.fleeing.has(w)) ??
        workers.find((w) => !this.fleeing.has(w) && world.state[w] !== STATE_BUILD)
      if (builder === undefined) continue
      if (this.sink) {
        this.emitResumeBuild(world, builder, id)
      } else {
        orderBuild(world, builder, id)
      }
    }
  }

  /**
   * Lockstep form of the construction resume: the 'build' command's siteId
   * targets an existing incomplete structure, and applyCommand orderBuilds
   * the worker to it instead of placing a new one.
   */
  private emitResumeBuild(world: World, workerId: number, siteId: number): void {
    const building = BUILDING_TYPE_BY_KIND[world.kind[siteId]]
    this.sink!({ type: 'build', step: 0, workerId, building, x: 0, z: 0, siteId })
  }

  private trainSoldiers(world: World, workerCount: number, reserveGold: number): void {
    if (workerCount < this.tuning.workersBeforeArmy) return
    const units = getUnits()
    const meleeCost = units['melee'].cost.gold
    const rangedCost = units['ranged'].cost.gold
    const meleeReserve = reserveGold * MELEE_RESERVE_FACTOR
    const gold = world.gold[this.team]
    const barracksIdle = structuresOf(world, this.team, KIND_BARRACKS, true).some(
      (id) => world.trainKind[id] === NO_TRAINING,
    )
    // Starved: an idle barracks while gold covers ranged but not melee. The
    // cheaper ranged would otherwise snipe every 80g increment and the 100g
    // melee would never accumulate (deterministic: world state + think ticks).
    const starved =
      this.favorMelee &&
      barracksIdle &&
      gold - reserveGold >= rangedCost &&
      gold - meleeReserve < meleeCost
    if (starved && this.meleeHoldTicks === 0) {
      this.meleeHoldTicks = MELEE_STARVE_HOLD_WINDOW // latch the hold
    }
    const holdRanged = this.meleeHoldTicks > 0
    if (this.meleeHoldTicks > 0) {
      this.meleeHoldTicks -= 1
      if (this.meleeHoldTicks === 0) this.favorMelee = false // expired: yield to ranged
    }

    const jobs: [number, 'melee' | 'ranged'][] = [
      [KIND_BARRACKS, 'melee'],
      [KIND_ARCHERY, 'ranged'],
    ]
    for (const [kind, unit] of jobs) {
      // Re-prioritize melee: hold the archery while the barracks is starved
      // so gold accumulates past the melee cost. Bounded by the hold window —
      // the archery can be throttled, never stalled.
      if (unit === 'ranged' && holdRanged) continue
      for (const id of structuresOf(world, this.team, kind, true)) {
        if (world.trainKind[id] !== NO_TRAINING) continue
        // Don't spend the gold reserved for the planned building. Melee
        // trains against the softened reserve (see MELEE_RESERVE_FACTOR).
        const reserve = unit === 'melee' ? meleeReserve : reserveGold
        const cost = unit === 'melee' ? meleeCost : rangedCost
        if (gold - reserve < cost) continue
        this.emitTrain(world, id, unit)
        // Alternation: a trained melee yields the next contested gold to
        // ranged, and vice versa — keeps the army mixed instead of sniped.
        if (unit === 'melee') {
          this.favorMelee = false
          this.meleeHoldTicks = 0
        } else {
          this.favorMelee = true
        }
      }
    }
  }

  /** Idle soldiers converge on any visible enemy near the hall. Returns true if defending. */
  private defend(world: World, hall: number, soldiers: number[]): boolean {
    const threat = this.nearestVisibleThreat(world, hall)
    if (threat === NO_TARGET) return false
    this.soundMilitiaBell(world, hall)
    const tx = world.positionX[threat]
    const tz = world.positionZ[threat]
    for (const id of soldiers) {
      if (world.state[id] !== STATE_IDLE) continue
      this.emitAttackMove(world, id, tx, tz)
    }
    return true
  }

  /**
   * Militia Bell (human racial): when an enemy soldier is inside the
   * defense radius, ring the hall bell so the peasants take up pikes
   * (4x damage Levy Pikemen) instead of being slaughtered at the
   * resource line — human lost 10-13 workers a game in the orc matchup
   * because this designed counter never fired for the AI (orc-human
   * audit 2026-10-22). Gates mirror ringMilitiaBell's own: human only
   * (it returns 0 for other factions), bell off cooldown, at least one
   * peasant inside muster range of the hall. One refinement: the threat
   * must be military — a lone enemy worker scouting the base must not
   * spend the 120s cooldown the real wave will need.
   */
  private soundMilitiaBell(world: World, hall: number): void {
    if (world.factionOfTeam[this.team] !== 'human') return
    if (world.matchTime < world.militiaCooldown[this.team]) return // still cooling down
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    let peasantInRange = false
    let militaryThreat = false
    for (const id of world.entities.keys()) {
      if (world.health[id] <= 0) continue
      const kind = world.kind[id]
      const d = Math.hypot(world.positionX[id] - hx, world.positionZ[id] - hz)
      if (world.team[id] === this.team) {
        if (kind === KIND_WORKER && d <= MILITIA_MUSTER_RADIUS) peasantInRange = true
      } else if (kind === KIND_MELEE || kind === KIND_RANGED) {
        if (d <= this.tuning.defenseRadius && canSee(world, this.team, id)) {
          militaryThreat = true
        }
      }
      if (peasantInRange && militaryThreat) break
    }
    if (!peasantInRange || !militaryThreat) return
    if (this.sink) {
      // Lockstep: the 'militia' command applies ringMilitiaBell on both
      // peers at the turn boundary (net/apply.ts).
      this.sink({ type: 'militia', step: 0, team: this.team })
    } else {
      world.ringMilitiaBell(this.team)
    }
  }

  /** How many soldiers to keep at home as garrison (scales with game time + personality). */
  private getGarrisonSize(): number {
    let base = 0
    if (this.gameTime >= 300) base = 3
    else if (this.gameTime >= 120) base = 2
    // Personalities adjust
    if (this.personality === 'defender') base += 2
    if (this.personality === 'aggressor') base = Math.max(0, base - 1)
    return base
  }

  /** Soldiers (beyond the garrison) this AI needs before it attacks.
   * Undead use their own lower threshold — see UNDEAD_ATTACK_ARMY. */
  private attackThreshold(world: World): number {
    return world.factionOfTeam[this.team] === 'undead'
      ? UNDEAD_ATTACK_ARMY
      : this.tuning.attackArmy
  }

  /** Once strong enough, idle soldiers march on the enemy hall (or search for it). */
  private attack(world: World, hall: number, soldiers: number[]): void {
    // The quiet opening: no AI attacks before the First Bell (3:00).
    // The Warlord personality still hits *at* the bell — see tuning.
    if (world.bellsRung[0] !== 1) return
    // Cold-start desperation: until the first corpse feeds Soul-Ash, an
    // undead garrison guards a cap that cannot grow — every soldier stays
    // home, no combat starts, no ash ever lands. garrisonFor waives it so
    // the horde seeks the contact its economy runs on. Once ash flows,
    // the normal garrison discipline resumes.
    const garrisonSize = this.garrisonFor(world)
    const available = soldiers.length - garrisonSize
    const forced = this.gameTime > 240 && available >= 3 // 4 min: attack with what you have
    if (!forced && available < this.attackThreshold(world)) return
    const idle = soldiers.filter((id) => world.state[id] === STATE_IDLE)
    // Reserve garrison: keep the closest soldiers to hall at home
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const sorted = [...idle].sort((a, b) => {
      const da = Math.hypot(world.positionX[a] - hx, world.positionZ[a] - hz)
      const db = Math.hypot(world.positionX[b] - hx, world.positionZ[b] - hz)
      return da - db
    })
    const attackers = sorted.slice(garrisonSize)
    if (attackers.length === 0) return
    const target = this.findTarget(world, hall, attackers)
    if (target === null) return
    for (const id of attackers) this.emitAttackMove(world, id, target.x, target.z)
  }

  /**
   * Battle micro — tactical retreat and wounded withdrawal. Runs every think
   * tick after attack/defend orders. Only soldiers engaged AWAY from the base
   * (beyond the defense radius) are eligible; the home garrison always holds.
   * Retreating units rally on the hall, go idle on arrival, and rejoin the
   * next wave the macro layer sends.
   */
  private microArmy(world: World, hall: number, soldiers: number[]): void {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const enemyTeam = (this.team === 0 ? 1 : 0) as 0 | 1
    // Snapshot the enemy's *visible* soldiers once per think tick. The AI
    // only reacts to what it can see — same fog rules as the human player.
    const enemies: number[] = []
    for (const id of world.entities.keys()) {
      if (world.team[id] !== enemyTeam || world.health[id] <= 0) continue
      const kind = world.kind[id]
      if (kind !== KIND_MELEE && kind !== KIND_RANGED) continue
      if (!canSee(world, this.team, id)) continue
      enemies.push(id)
    }
    const retreatRatio = RETREAT_RATIO[this.personality]
    const withdrawWounded = this.personality !== 'aggressor'
    for (const id of soldiers) {
      if (world.health[id] <= 0) continue
      const st = world.state[id]
      if (st !== STATE_ATTACK && st !== STATE_ATTACKMOVE) continue
      const ux = world.positionX[id]
      const uz = world.positionZ[id]
      // Home defense holds the line regardless of the odds.
      if (Math.hypot(ux - hx, uz - hz) <= this.tuning.defenseRadius) continue
      // Wounded withdrawal: a badly hurt soldier pulls back to the hall.
      if (withdrawWounded && world.health[id] < world.maxHealth[id] * WOUNDED_FRACTION) {
        this.emitMove(world, id, hx, hz)
        continue
      }
      // Local strength comparison around this unit (health-weighted).
      let own = 0
      let foe = 0
      for (const s of soldiers) {
        if (world.health[s] <= 0) continue
        if (Math.hypot(world.positionX[s] - ux, world.positionZ[s] - uz) <= MICRO_RADIUS) {
          own += world.health[s]
        }
      }
      for (const e of enemies) {
        if (Math.hypot(world.positionX[e] - ux, world.positionZ[e] - uz) <= MICRO_RADIUS) {
          foe += world.health[e]
        }
      }
      if (own > 0 && foe > own * retreatRatio) {
        this.emitMove(world, id, hx, hz)
      }
    }
  }

  /** Where to send the army: the enemy hall if explored, else the mirror guess, else search. */
  private findTarget(
    world: World,
    hall: number,
    army: number[],
  ): { x: number; z: number } | null {
    const enemyTeam = (this.team === 0 ? 1 : 0) as 0 | 1
    const enemyHall = structuresOf(world, enemyTeam, KIND_HALL, false)[0]
    if (enemyHall !== undefined) {
      const ex = world.positionX[enemyHall]
      const ez = world.positionZ[enemyHall]
      if (isExplored(world, this.team, ex, ez)) return { x: ex, z: ez } // Seen it: attack.
    }
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const guess = { x: -hx, z: hz } // Mirror of our own start.
    if (!isExplored(world, this.team, guess.x, guess.z)) return guess

    // Nothing there: search the nearest unexplored point from the army's centre.
    let cx = 0
    let cz = 0
    for (const id of army) {
      cx += world.positionX[id]
      cz += world.positionZ[id]
    }
    cx /= army.length
    cz /= army.length
    let best: { x: number; z: number } | null = null
    let bestDist = Infinity
    for (const p of SEARCH_POINTS) {
      if (isExplored(world, this.team, p.x, p.z)) continue
      const d = Math.hypot(p.x - cx, p.z - cz)
      if (d < bestDist) {
        bestDist = d
        best = p
      }
    }
    return best
  }
}

/** Coarse grid over the map used when the enemy base has not been found. */
const SEARCH_POINTS: { x: number; z: number }[] = []
for (const x of [-60, -30, 0, 30, 60]) {
  for (const z of [-50, 0, 50]) SEARCH_POINTS.push({ x, z })
}

function structuresOf(world: World, team: 0 | 1, kind: number, builtOnly: boolean): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind) continue
    if (world.team[id] !== team) continue
    if (world.health[id] <= 0) continue
    if (builtOnly && world.buildProgress[id] < world.buildTotal[id]) continue
    found.push(id)
  }
  return found
}

function unitsOf(world: World, team: 0 | 1, kind: number): number[] {
  const found: number[] = []
  for (const id of world.entities.keys()) {
    if (world.kind[id] !== kind) continue
    if (world.team[id] !== team) continue
    found.push(id)
  }
  return found
}
