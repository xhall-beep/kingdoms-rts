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
  KIND_SMITHY,
  KIND_WORKER,
  KIND_WORKSHOP,
  NO_TARGET,
  NO_TRAINING,
  STATE_IDLE,
  STATE_BUILD,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  KIND_GOLDMINE,
  KIND_SHRINE,
  KIND_TREE,
  isBuildingKind} from '../core/World'
import { orderBuild, orderGather } from '../systems/gather.ts'
import { BUILD_RING_OFFSETS } from '../core/Math.ts'
import { orderAttackMove } from '../systems/combat.ts'
import { orderMove } from '../systems/movement.ts'
import { HORN_COST, RALLY_NONE, soundWarHorn, warChargeAtLeast } from '../systems/warhorn.ts'
import { CAPTURE_RADIUS } from '../systems/shrines.ts'
import { enqueueTrain, researchCost, researchUpgrade, trainingQueueFor, upgradeBuilding } from '../systems/production.ts'
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
const FLEE_CLEARANCE = 2 // An extended rally sits this far beyond the threat's trigger radius.
/**
 * Battle micro: each engaged soldier compares local strength (its own side's
 * health within MICRO_RADIUS vs the visible enemy's) and pulls back to the
 * hall when outmatched. Deterministic: pure world-state evaluation, no RNG.
 */
const MICRO_RADIUS = 18 // Local fight window for the strength comparison.
const WOUNDED_FRACTION = 0.3 // Below this health fraction a soldier withdraws.
/**
 * Ranged kiting: combat.ts notes ranged units "kite melee effectively",
 * but no code ever did it — an engaged ranged unit stood and traded
 * against a closing melee at 1.25x damage against it, on 85 HP vs the
 * melee's 170. A ranged unit therefore steps back when a visible enemy
 * melee gets inside KITE_TRIGGER, to a point KITE_STANDOFF from that
 * melee: outside melee reach (2.1) but inside its own weapon range
 * (11), so after the move order completes it re-engages from range.
 * Only where the outmatched-retreat above did not already fire — a
 * losing fight retreats to the hall, a winnable one kites.
 */
const KITE_TRIGGER = 6 // A visible enemy melee this close starts a kite step.
const KITE_STANDOFF = 9 // Kite destination's distance from the closing melee.
/**
 * Kite refinement (always-be-shooting): a step back buys survival only
 * when the threat can actually arrive. A closing melee at or below this
 * health fraction dies to the local fight before it lands a blow, so
 * the archer holds and shoots instead. Mirrors the wounded-withdrawal
 * band's logic from the threat's side.
 */
const KITE_DYING_FRACTION = 0.25
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
 * War Horn discipline. The horn was a player-only instrument: charge
 * accrues from damage dealt (warhorn.ts), but no AI code ever spent it —
 * the systems audit's 12-minute AI-vs-AI probe measured both AIs sitting
 * at the 100 cap for minutes and then losing the whole meter to Coward's
 * Decay, rallyEver = [false, false]. The step that spends it
 * (soundWarHornStep) follows the surveyed doctrine for charged army
 * abilities: never fire on the meter alone — the gate is the meter AND a
 * counted force in, entering, or about to enter a concrete fight; the
 * rally is picked by the fight's shape (heal the bleed, buff the clash,
 * speed the approach); and a meter about to be deleted by decay is
 * converted rather than wasted. All thresholds live in this one record,
 * in the RETREAT_RATIO style, so personalities differ by WHEN the horn
 * sounds and which rally answers:
 * - aggressor fires at the first 50, in any real fight; it stays in
 *   fights (it is exempt from wounded withdrawal), so its Wind window
 *   is the latest — the army must be truly bleeding.
 * - defender is defense-first: at home it fires from 50 on the Militia
 *   Bell's terms (base under attack), preferring Second Wind with the
 *   workers counted in the cluster — Wind is the only rally that heals
 *   them. Offensively it spends only on a full meter, and only into a
 *   real clash (the highest clashMin).
 * - expander fires at 50 like the aggressor, but its Gale March is
 *   coupled to the shrine: when contestShrine's emergency branch sends
 *   a sortie, the horn speeds its arrival.
 */
interface HornProfile {
  fireCharge: number // charge floor for offensive firing (defensive fires at HORN_COST)
  clashMin: number // engaged own soldiers an Ironblood clash requires
  windHp: number // aggregate engaged health fraction at/below which Second Wind answers
  defenseFirst: boolean // a home fight pre-empts all offensive firing
}

const HORN_PROFILE: Record<AIPersonality, HornProfile> = {
  aggressor: { fireCharge: 50, clashMin: 3, windHp: 0.55, defenseFirst: false },
  defender: { fireCharge: 100, clashMin: 5, windHp: 0.70, defenseFirst: true },
  expander: { fireCharge: 50, clashMin: 4, windHp: 0.65, defenseFirst: false },
}
/** Second Wind needs this many engaged (or home-cluster) bodies: below
 * it, a 30% heal is worth less than a buff. */
const HORN_WIND_MIN_BODIES = 4
/** Ironblood wants a real fight: visible foe health in the engaged
 * cluster at least this fraction of the cluster's own health. */
const HORN_CLASH_FOE_FRACTION = 0.5
/**
 * Coward's Decay wipes the horn after 45 s without dealing damage
 * (warhorn.ts). With this many peace ticks elapsed the meter is ~15 s
 * from deletion — the anti-decay conversion window.
 */
const HORN_DECAY_WARN_TICKS = 30 * 60

/**
 * AI research discipline: the upgrade ladder was only ever driven from
 * the player UI, so in AI-vs-AI every faction's research sat dark —
 * including human's Adaptable discount, its signature (orc-human audit
 * 2026-10-22). The first gate (bank >= 400, army >= attack threshold)
 * fixed the wiring but not the firing: the bank-dynamics audit
 * (2026-10-22) measured the AI economy as a pure flow — human/elf think
 * banks median 42/44g, max the 200g starting stake, 0 of 14,762 think
 * ticks ever >= 400 — so the floor sampled a stock that does not exist
 * and research fired 5 times in 72 team-games, 0 for human/elf. The
 * gate now floors on the picked ladder's own next-level cost for the
 * faction (100g/50w; 80g/40w for human via Adaptable, see researchCost)
 * — a price the flow actually reaches — and asks only for a small
 * standing army (RESEARCH_MIN_ARMY) so the opening ramp, where gold
 * converts straight into soldiers every think, stays untaxed (an
 * earlier draft with floor 250 and no army precondition halved
 * undead's 5:00 peak army in the cold-start pins). Counterfactual
 * replay on recorded think traces predicts ~1.00 fires/team-game for
 * human/elf/orc and ~2.61 for undead (its supply gate pools gold), first
 * level ~2:40–2:55. Think order is unchanged — upgradeOrcBuildings
 * still runs first, so tiers keep first claim on any bank, and since
 * the floor is cost-denominated the gate taxes flow and never creates
 * a bank: no foundry coupling (measured). The reserve/tithe alternative
 * was measured as a trap — it wakes orc's tiers (1.33 spends/game)
 * while human research stays 0.00 — and is deliberately not used.
 *
 * One calibration the audit's replay could not see (it held recorded
 * army traces fixed, so a virtual fire's 100g never cost a real
 * soldier): in vivo, a pooled bank buys the ladder back-to-back, one
 * level per think — undead fired 6 levels by 3:12 in its cold-start
 * matchup (predicted: 2.61 per game), spent its corpse-loop spin-up,
 * and its 5:00 army peak fell 6 -> 4, breaking the cold-start pins.
 * RESEARCH_PACE restores the audit's predicted envelope (~1 fire per
 * team-game for the bank-limited factions, ~2.61 for undead, first
 * level ~2:40–2:55) by pacing purchases: the floor decides WHETHER
 * the AI can research, the pace decides how fast it climbs.
 */
const RESEARCH_MIN_ARMY = 3
/** Minimum seconds between one AI's research purchases (see above). */
const RESEARCH_PACE = 120
/** Melee first: winners' armies run ~58% melee, so its ladder pays most. */
const RESEARCH_ORDER: readonly UpgradeType[] = ['meleeDmg', 'meleeHp', 'rangedDmg']

/**
 * Opening infantry commitment (Balance Slice 1, 2026-10-27). The
 * measured defect: the barracks finishes ~1:06, but the build plan
 * reserved every spare gold for the next building in the tech chain,
 * so the barracks stood idle until the chain completed — the shipped
 * AI fielded ZERO soldiers before ~2:25 in all 36 persona-bench
 * matches, its army value at first blood was 0 in 8 of 9 rush cells,
 * and a pure-melee rush went 9-0 against it (balance series
 * 2026-10-26). The gate: expand() will not START the second tech
 * building (the Smithy / Archery Range in personality order — the
 * Workshop is the first) until this many melee stand committed:
 * fielded, in a barracks' active training slot, or waiting in its
 * queue. Suppressing the want also zeroes that think's training
 * reserve, so the gold the chain would have banked flows into the
 * barracks instead. Counted from live world state every think, so
 * production lost with a destroyed barracks re-engages the gate
 * instead of crediting ghosts. The aggressor commits heaviest (3);
 * defender and expander commit 2 — the expander's commitment lands
 * latest through its own economy-first tuning, not a smaller promise.
 * Everything downstream of the gate is untouched: once the second
 * tech building starts, the chain, research, and horn run as before.
 *
 * The gate is OPENING-ONLY (fix, 2026-10-27). The proving series
 * staged a mid-game wipe + tech-building loss under live pressure:
 * the gate re-engaged (it counted from live state), survival spending
 * never assembled the commitment while the tech want sat nulled, and
 * the AI never re-teched — a lost fight became a permanent tech
 * freeze. The lever's measured defect was always the opening (zero
 * units before ~2:25 at game start), so the gate now retires for the
 * rest of the match the first time BOTH chain tech buildings have
 * stood finished (techFirstCompleted / techSecondCompleted, latched
 * in expand). A tech building destroyed before it ever completes
 * does not retire anything — the chain never stood, and the opening
 * gate stays live, which is the correct side of that line.
 */
const OPENING_MELEE_COMMITMENT: Record<AIPersonality, number> = {
  aggressor: 3,
  defender: 2,
  expander: 2,
}

/**
 * Opening advance delay (pacing slice 2026-10-27): the first offensive
 * wave may not launch before this gameTime (sim seconds), per
 * personality. Defense, shrine sorties, horn, training and micro are
 * deliberately NOT gated — the pacing study's measured ecosystem
 * (rusher row and AI-vs-AI outcomes byte-identical) holds with only
 * the march held. Values are L1-A; the pre-measured escalation path
 * is L1-C 240/240/255, then L1-B 255/255/270.
 */
const OPENING_ADVANCE_DELAY_SEC: Record<AIPersonality, number> = {
  aggressor: 225,
  defender: 225,
  expander: 240,
}

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
  /** gameTime of this AI's last research purchase (RESEARCH_PACE gate). */
  private lastResearchAt = -Infinity
  /** Opening-gate retirement (Balance Slice 1 fix, 2026-10-27): latched
   * the first time expand() sees the chain's first / second tech
   * building FINISHED. When both have stood, the opening is over and
   * the melee-commitment gate never engages again — see
   * OPENING_MELEE_COMMITMENT. Per-instance like every other field here:
   * AI state lives outside the hashed world state, is rebuilt with the
   * AI each match, and twin peers run identical instances, so the twin
   * stays A=B. */
  private techFirstCompleted = false
  private techSecondCompleted = false
  /** Set by contestShrine's emergency branch when it dispatches a sortie
   * this think; consumed by soundWarHornStep in the same think (the
   * expander's Gale March coupling). Reset at the top of every think. */
  private shrineSortie = false
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
      this.sink({ type: 'train', step: 0, buildingId, unit, team: this.team })
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
    this.shrineSortie = false // Fresh each think; contestShrine may set it.

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
    const defended = this.defend(world, hall, soldiers)
    if (!defended) this.attack(world, hall, soldiers)
    this.soundWarHornStep(world, hall, soldiers, defended)
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
      // The horn step reads this in the same think: a sortie is en
      // route to the game's decisive point (see HORN_PROFILE).
      this.shrineSortie = true
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
   * AI research step (all factions). Buys at most one level per
   * purchase, paced by RESEARCH_PACE: the first ladder below max whose
   * own building (smithy for melee, archery for ranged — per
   * UPGRADES) stands finished and whose next-level cost — priced for
   * this faction, so human's Adaptable discount (0.8x) is the floor
   * human is gated on — the bank covers, and only once a small
   * standing army exists (RESEARCH_MIN_ARMY; see the gate's design
   * note at the constant). researchUpgrade charges exactly the price
   * the gate floors on (researchCost), so a passed gate always lands
   * the level.
   *
   * Lockstep: applied directly, exactly like the AI's orc tier upgrades
   * (upgradeBuilding in upgradeOrcBuildings). There is no 'research'
   * Command type — adding one would change the PvP wire protocol — and
   * the AI joins lockstep only in single-world practice mode, where a
   * deterministic direct mutation cannot diverge between peers (real
   * PvP fields no AI). The levels are hashed world state (net/hash.ts).
   */
  private researchUpgrades(world: World): void {
    // Pace: a pooled bank must not sprint the whole ladder in a handful
    // of thinks (see RESEARCH_PACE) — purchases are mid-game beats.
    if (this.gameTime - this.lastResearchAt < RESEARCH_PACE) return
    // Upgrade the army you have: no standing army, no research. This
    // keeps the opening ramp (where gold converts straight into
    // soldiers every think) untaxed.
    const soldiers =
      unitsOf(world, this.team, KIND_MELEE).length +
      unitsOf(world, this.team, KIND_RANGED).length
    if (soldiers < RESEARCH_MIN_ARMY) return
    for (const type of RESEARCH_ORDER) {
      const def = UPGRADES[type]
      const level =
        type === 'meleeDmg'
          ? world.meleeDmgLvl[this.team]
          : type === 'meleeHp'
            ? world.meleeHpLvl[this.team]
            : world.rangedDmgLvl[this.team]
      if (level >= def.maxLevel) continue
      const kind = def.building === 'archery' ? KIND_ARCHERY : KIND_SMITHY
      const building = structuresOf(world, this.team, kind, true)[0]
      if (building === undefined) continue
      // Floor = this ladder's own cost for this faction. If the picked
      // ladder is unaffordable the step stands down (no cascade to a
      // later ladder), exactly as the pre-redesign step did when
      // researchUpgrade declined.
      const cost = researchCost(world, this.team, type)
      if (world.gold[this.team] < cost.gold || world.wood[this.team] < cost.wood) return
      researchUpgrade(world, building, type)
      this.lastResearchAt = this.gameTime
      return // One level per purchase, paced by RESEARCH_PACE — no cascade.
    }
  }

  private trainWorkers(world: World, hall: number, workerCount: number): void {
    // In production = the active slot + the waiting queue behind it.
    const queued =
      (world.trainKind[hall] !== NO_TRAINING ? 1 : 0) + world.trainQueueLen[hall]
    let target = this.tuning.workerTarget
    if (world.factionOfTeam[this.team] === 'undead') {
      // No farms: never let workers consume the entire supply cap (see
      // UNDEAD_ARMY_SUPPLY_RESERVE). Other factions are unaffected.
      target = Math.min(
        target,
        Math.max(0, world.supplyCap[this.team] - UNDEAD_ARMY_SUPPLY_RESERVE),
      )
    }
    // One-at-a-time pacing, unchanged from the single-slot era: start a
    // worker only when the slot is free. Emits while busy used to be
    // refused outright; now they would land in the queue and
    // pre-commit gold the build plan expects to spend elsewhere.
    if (
      world.trainKind[hall] === NO_TRAINING &&
      workerCount + queued < target
    ) {
      this.emitTrain(world, hall, 'worker')
    }
  }

  /**
   * Workers harvest, keeping roughly WOOD_SHARE on wood. Workers the gather
   * system auto-assigned (HARVEST_ANY) are converted proactively: waiting for
   * them to go IDLE first loses the race to the gather system every tick and
   * leaves the economy hypersensitive to spawn geometry.
   */
  /**
   * Worker micro: threat is evaluated per worker. A worker evacuates
   * behind the hall when a visible enemy is within FLEE_TRIGGER of the
   * WORKER, and is released the think no visible enemy is near it — the
   * normal rotation then re-arms it. The previous hall-centric trigger
   * (any visible enemy inside the hall's defense radius) could not see a
   * raider working the far wood line beyond that radius, and its global
   * release meant one parked enemy held every evacuee out for as long as
   * it stood anywhere inside the radius — the evacuation freeze the elf
   * audit found. Per-worker release closes that class: a parked enemy
   * can only hold the workers it is actually near (post-ring defense
   * audit 2026-10-23, Finding 3).
   * The rally an evacuee is sent to is itself never inside the
   * triggering threat's radius — see fleeDestination.
   * Mustered militia are exempt: they hold their stand instead of fleeing.
   * Deterministic: same visible state always yields the same orders.
   */
  private evacuateWorkers(world: World, hall: number, workers: number[]): void {
    // Prune workers that died while evacuated.
    for (const id of this.fleeing) {
      if (!world.entities.has(id)) this.fleeing.delete(id)
    }
    for (const id of workers) {
      if (id === this.scoutId) continue // The scout keeps its mission.
      // Militia Bell: a mustered pikeman chose to fight. Re-ordering it
      // behind the hall every think walks the muster off its stand —
      // the bank-dynamics audit's ring census found ~half the pikemen
      // stuck in STATE_MOVE at +5s, arriving late to their own fight.
      // The gather system already exempts militia from harvesting
      // (gather.ts); this is the matching evacuation exemption. Drop
      // any stale evacuee mark: if the militia lapses mid-raid, the
      // next think re-orders and re-marks it through the normal path.
      if (world.isMilitia(id)) {
        this.fleeing.delete(id)
        continue
      }
      // A worker mid-construction stays on the site: yanking it abandons the
      // structure, and a raid scare is not worth a permanently stalled
      // barracks (the supervisor below re-arms genuine losses, but avoiding
      // the churn keeps the build on schedule).
      if (world.state[id] === STATE_BUILD) continue
      if (!world.entities.has(id) || world.health[id] <= 0) continue
      const threat = this.nearestVisibleThreatTo(
        world,
        world.positionX[id],
        world.positionZ[id],
        FLEE_TRIGGER,
      )
      if (threat === NO_TARGET) {
        // Released: no visible enemy near THIS worker, whatever is
        // happening elsewhere in the base.
        this.fleeing.delete(id)
        continue
      }
      const dest = this.fleeDestination(world, hall, threat)
      this.emitMove(world, id, dest.x, dest.z)
      this.fleeing.add(id)
    }
  }

  /**
   * Rally point: behind the hall on the far side of the threat — but
   * never inside the triggering threat's own trigger radius. The plain
   * rally (FLEE_STANDOFF behind the hall) lands within FLEE_TRIGGER of
   * a besieger standing at the resource line, because a base's whole
   * worker footprint fits inside one trigger radius: evacuees parked
   * there were still "near a visible enemy" on every later think, so
   * the fleeing set became an absorbing state for the whole siege
   * (human-v-undead audit 2026-10-23, cause 1: 11 of 12 workers pinned
   * by two besiegers, working worker-seconds down 23-35%). When the
   * plain rally is inside the radius, extend the standoff along the
   * threat→rally ray until the destination clears the radius, so an
   * evacuee that reaches it is released by the ordinary per-worker
   * check and cycles back to work instead of re-pinning at its own
   * rally point. FLEE_TRIGGER itself is unchanged — only the
   * destination moves, and the destination is a closed-form point, so
   * no hold can outlive the threat's actual proximity.
   */
  private fleeDestination(world: World, hall: number, threat: number): { x: number; z: number } {
    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    const tx = world.positionX[threat]
    const tz = world.positionZ[threat]
    let dx = hx - tx
    let dz = hz - tz
    const d = Math.hypot(dx, dz)
    if (d < 1e-6) {
      dx = 1
      dz = 0
    } else {
      dx /= d
      dz /= d
    }
    let x = hx + dx * FLEE_STANDOFF
    let z = hz + dz * FLEE_STANDOFF
    // Still inside the triggering threat's radius? Push the rally out
    // along the ray from the threat through the rally until it clears
    // the radius (plus FLEE_CLEARANCE, so the release check — which
    // counts a worker at exactly the radius as threatened — actually
    // lets go on arrival). The rally stays on the far side of the hall
    // from the threat; only its distance grows.
    const rx = x - tx
    const rz = z - tz
    const rd = Math.hypot(rx, rz)
    if (rd <= FLEE_TRIGGER) {
      if (rd < 1e-6) {
        x = tx + dx * (FLEE_TRIGGER + FLEE_CLEARANCE)
        z = tz + dz * (FLEE_TRIGGER + FLEE_CLEARANCE)
      } else {
        const scale = (FLEE_TRIGGER + FLEE_CLEARANCE) / rd
        x = tx + rx * scale
        z = tz + rz * scale
      }
    }
    const clamp = (v: number): number => Math.max(-MAP_CLAMP, Math.min(MAP_CLAMP, v))
    return { x: clamp(x), z: clamp(z) }
  }

  /**
   * Nearest enemy unit the AI can currently see inside its defense radius.
   * Deterministic: ties break on the spatial hash sequence number.
   */
  private nearestVisibleThreat(world: World, hall: number): number {
    return this.nearestVisibleThreatTo(
      world,
      world.positionX[hall],
      world.positionZ[hall],
      this.tuning.defenseRadius,
    )
  }

  /**
   * Nearest visible enemy within `radius` of an arbitrary point.
   * Deterministic: ties break on the spatial hash sequence number.
   */
  private nearestVisibleThreatTo(world: World, x: number, z: number, radius: number): number {
    const hash = world.spatialHash
    let threat = NO_TARGET
    let nearest = radius
    let bestSeq = Number.MAX_SAFE_INTEGER
    const consider = (id: number) => {
      const kind = world.kind[id]
      if (kind !== KIND_WORKER && kind !== KIND_MELEE && kind !== KIND_RANGED) return
      if (world.team[id] === this.team) return
      if (!canSee(world, this.team, id)) return
      const d = Math.hypot(world.positionX[id] - x, world.positionZ[id] - z)
      const seq = hash.sequenceOf(id)
      if (d < nearest || (d === nearest && seq < bestSeq)) {
        nearest = d
        bestSeq = seq
        threat = id
      }
    }
    // Spatial hash rect query covers the circle exactly (any radius).
    hash.forEachInRect(x - radius, z - radius, x + radius, z + radius, consider)
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

  /**
   * Melee this AI has committed to the field: soldiers standing plus
   * melee in production at its barracks (the active training slot and
   * the waiting queue behind it). The opening gate's yardstick — see
   * OPENING_MELEE_COMMITMENT.
   */
  private openingMeleeCommitted(world: World): number {
    let n = unitsOf(world, this.team, KIND_MELEE).length
    for (const id of structuresOf(world, this.team, KIND_BARRACKS, false)) {
      if (world.trainKind[id] === KIND_MELEE) n += 1
      for (const queued of trainingQueueFor(world, id)) {
        if (queued === 'melee') n += 1
      }
    }
    return n
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
    // Tech tree (2026-10-26): the Workshop is the tech root — it goes up
    // right after the first Barracks (the economy opener is the `ready`
    // gate above), and the Smithy / Archery Range follow in personality
    // order: the aggressor takes the Range first (archer pressure), the
    // defender the Smithy first (armor for the turtle), the expander the
    // Range as part of its boom, its Smithy after the second farm beat.
    // The wants additionally require a FINISHED workshop — placement is
    // gated in construction.ts, and an AI that queued a tech building
    // behind an unfinished root would just burn the think. A destroyed
    // tech building re-enters the chain on its own: its count falls to
    // zero and the chain wants it again (the workshop first of all).
    // Balance Slice 1 (2026-10-27) inserts the opening infantry
    // commitment between the Workshop and the rest of the chain:
    // techFirst/techSecond are not STARTED until the barracks has
    // committed the personality's opening melee (see
    // OPENING_MELEE_COMMITMENT and the gate below).
    const workshopReady = structuresOf(world, team, KIND_WORKSHOP, true).length > 0
    const techFirst = this.personality === 'defender' ? KIND_SMITHY : KIND_ARCHERY
    const techSecond = this.personality === 'defender' ? KIND_ARCHERY : KIND_SMITHY
    // Opening-gate retirement: latch each chain step the first time it
    // is seen FINISHED. Polled from live state like every other chain
    // check here, so a building destroyed before completing never
    // latches (the opening is still the opening), and one destroyed
    // after completing stays latched (the opening happened — mid-game
    // re-tech is none of the gate's business anymore).
    if (!this.techFirstCompleted && structuresOf(world, team, techFirst, true).length > 0) {
      this.techFirstCompleted = true
    }
    if (!this.techSecondCompleted && structuresOf(world, team, techSecond, true).length > 0) {
      this.techSecondCompleted = true
    }
    const openingComplete = this.techFirstCompleted && this.techSecondCompleted
    let want: number | null = null
    if (ready && all(KIND_BARRACKS) === 0) want = KIND_BARRACKS
    else if (ready && all(KIND_WORKSHOP) === 0) want = KIND_WORKSHOP
    else if (needsFarms && slack <= 1 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && workshopReady && all(techFirst) === 0) want = techFirst
    else if (needsFarms && slack <= 3 && pending(KIND_FARM) === 0) want = KIND_FARM
    else if (ready && workshopReady && all(techSecond) === 0) want = techSecond
    else if (ready && world.gold[team] >= 400 && all(KIND_BARRACKS) < 2 && pending(KIND_BARRACKS) === 0) {
      want = KIND_BARRACKS
    }
    // Opening infantry commitment gate: the second tech building
    // waits until the first barracks has put the personality's melee
    // into production. Nulling the want also returns a zero reserve
    // below, so the gold the chain would have banked this think
    // trains soldiers instead. (The slack<=1 farm branch sits ahead
    // of techFirst in the chain, so a supply-blocked AI still farms
    // its way out — the gate cannot deadlock the opening.) Once the
    // full chain has stood finished the gate is retired (see
    // OPENING_MELEE_COMMITMENT): a mid-game wipe must re-tech on the
    // chain's own timing, not wait to re-assemble the opening
    // commitment under fire.
    if (
      !openingComplete &&
      (want === techFirst || want === techSecond) &&
      this.openingMeleeCommitted(world) < OPENING_MELEE_COMMITMENT[this.personality]
    ) {
      want = null
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
      const r = ringBase + ring * 4
      // Deterministic ring offsets from a literal table — no runtime trig
      // (Math.cos/sin are not cross-platform exact; see BUILD_RING_OFFSETS).
      const [cos, sin] = BUILD_RING_OFFSETS[k]
      const bx = hx + cos * r
      const bz = hz + sin * r
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
      if (!isBuildingKind(kind)) continue
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
    // Tech rework (2026-10-26): ranged are hired at the BARRACKS, unlocked
    // by a finished Archery Range — production.ts enforces the same gate
    // in the sim, so this side only decides the mix. The two-queue dance
    // (barracks melee / archery ranged in parallel) collapses into one
    // queue per barracks: each idle barracks hires its favored class
    // first, and training one class yields the next contested gold to
    // the other, so the army still mixes instead of sniping.
    const hasRange = structuresOf(world, this.team, KIND_ARCHERY, true).length > 0
    const barracksList = structuresOf(world, this.team, KIND_BARRACKS, true)
    const barracksIdle = barracksList.some(
      (id) => world.trainKind[id] === NO_TRAINING,
    )
    // Starved: an idle barracks while gold covers ranged but not melee. The
    // cheaper ranged would otherwise snipe every 80g increment and the 100g
    // melee would never accumulate (deterministic: world state + think ticks).
    let gold = world.gold[this.team]
    const starved =
      this.favorMelee &&
      hasRange &&
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

    for (const id of barracksList) {
      if (world.trainKind[id] !== NO_TRAINING) continue
      // Favored class first; the other class is the fallback when the
      // favored one is unaffordable — except a held ranged (the starve
      // hold above), which is skipped so the gold can reach melee cost.
      // The hold is bounded by MELEE_STARVE_HOLD_WINDOW: ranged production
      // can be throttled, never stalled.
      const order: ('melee' | 'ranged')[] = this.favorMelee
        ? ['melee', 'ranged']
        : ['ranged', 'melee']
      for (const unit of order) {
        if (unit === 'ranged' && !hasRange) continue // locked: no finished Range
        if (unit === 'ranged' && holdRanged) continue
        // Don't spend the gold reserved for the planned building. Melee
        // trains against the softened reserve (see MELEE_RESERVE_FACTOR).
        const reserve = unit === 'melee' ? meleeReserve : reserveGold
        const cost = unit === 'melee' ? meleeCost : rangedCost
        if (gold - reserve < cost) continue
        this.emitTrain(world, id, unit)
        gold -= cost // local shadow: keeps sink-mode emission honest too
        // Alternation: a trained melee yields the next contested gold to
        // ranged, and vice versa — keeps the army mixed instead of sniped.
        if (unit === 'melee') {
          this.favorMelee = false
          this.meleeHoldTicks = 0
        } else {
          this.favorMelee = true
        }
        break // one hire per barracks per think, as before
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

  /**
   * Sound the War Horn through the same emission split as the Militia
   * Bell: lockstep mode emits the 'warhorn' command (applied by
   * net/apply.ts on both peers); direct mode applies it now.
   */
  private emitWarHorn(world: World, rally: 1 | 2 | 3): void {
    if (this.sink) {
      this.sink({ type: 'warhorn', step: 0, team: this.team, rally })
    } else {
      soundWarHorn(world, this.team, rally)
    }
  }

  /**
   * War Horn step — runs after the defend/attack dispatch, before
   * microArmy, so it reads the fight the macro layer just committed to:
   * the wave attack() launched is in STATE_ATTACKMOVE, the defense
   * defend() converged is closing on the threat. At most one rally per
   * think. Every input is world state — no RNG, no memory beyond the
   * shrine-sortie flag set earlier this same think. See HORN_PROFILE
   * for the doctrine and the per-personality thresholds.
   *
   * Engagement is microArmy's aggregation lifted to army level: an own
   * soldier is engaged when it stands in STATE_ATTACK/STATE_ATTACKMOVE
   * with at least one visible enemy soldier inside MICRO_RADIUS. A wave
   * is "advancing" when a soldier attack-moves unengaged beyond the
   * defense radius — en route to contact, not converging at home.
   */
  private soundWarHornStep(world: World, hall: number, soldiers: number[], defended: boolean): void {
    const team = this.team
    if (!warChargeAtLeast(world, team, HORN_COST)) return
    // A buff rally is already sounding: soundWarHorn would refuse, so
    // don't spend the decision. (Second Wind sets no rallyKind and
    // never blocks.)
    if (world.rallyKind[team] !== RALLY_NONE && world.rallyUntil[team] > world.matchTime) return
    const profile = HORN_PROFILE[this.personality]
    const enemyTeam = (team === 0 ? 1 : 0) as 0 | 1

    // Visible enemy soldiers — the same fog discipline as microArmy.
    const enemies: number[] = []
    for (const id of world.entities.keys()) {
      if (world.team[id] !== enemyTeam || world.health[id] <= 0) continue
      const kind = world.kind[id]
      if (kind !== KIND_MELEE && kind !== KIND_RANGED) continue
      if (!canSee(world, team, id)) continue
      enemies.push(id)
    }

    const hx = world.positionX[hall]
    const hz = world.positionZ[hall]
    let engagedCount = 0
    let ownHp = 0
    let ownMaxHp = 0
    const engagedFoes = new Set<number>()
    let advancing = false
    for (const id of soldiers) {
      if (world.health[id] <= 0) continue
      const st = world.state[id]
      if (st !== STATE_ATTACK && st !== STATE_ATTACKMOVE) continue
      const ux = world.positionX[id]
      const uz = world.positionZ[id]
      let engaged = false
      for (const e of enemies) {
        if (Math.hypot(world.positionX[e] - ux, world.positionZ[e] - uz) <= MICRO_RADIUS) {
          engaged = true
          engagedFoes.add(e)
        }
      }
      if (engaged) {
        engagedCount += 1
        ownHp += world.health[id]
        ownMaxHp += world.maxHealth[id]
      } else if (
        st === STATE_ATTACKMOVE &&
        Math.hypot(ux - hx, uz - hz) > this.tuning.defenseRadius
      ) {
        advancing = true
      }
    }
    let foeHp = 0
    for (const e of engagedFoes) foeHp += world.health[e]
    const ownFrac = ownMaxHp > 0 ? ownHp / ownMaxHp : 1

    // Defensive track (defender): the base is under attack this think,
    // and defense pre-empts offense — no offensive rule is evaluated.
    // The Wind cluster counts the workers standing in the threatened
    // radius alongside the engaged soldiers; Ironblood answers being
    // outnumbered but holding. A lone scout cannot bait either: it is
    // not in the military foe sums, and an unhurt cluster fails the
    // Wind fraction.
    if (profile.defenseFirst && defended) {
      let bodies = engagedCount
      let hp = ownHp
      let maxHp = ownMaxHp
      for (const id of unitsOf(world, team, KIND_WORKER)) {
        if (world.health[id] <= 0) continue
        if (Math.hypot(world.positionX[id] - hx, world.positionZ[id] - hz) <= this.tuning.defenseRadius) {
          bodies += 1
          hp += world.health[id]
          maxHp += world.maxHealth[id]
        }
      }
      if (bodies >= HORN_WIND_MIN_BODIES && maxHp > 0 && hp / maxHp <= profile.windHp) {
        this.emitWarHorn(world, 3)
      } else if (engagedCount >= 1 && foeHp > ownHp) {
        this.emitWarHorn(world, 2)
      }
      return
    }

    if (warChargeAtLeast(world, team, profile.fireCharge)) {
      // Second Wind: the perishable window — damaged-but-alive bodies,
      // enough of them that a 30% heal outvalues a buff.
      if (engagedCount >= HORN_WIND_MIN_BODIES && ownFrac <= profile.windHp) {
        this.emitWarHorn(world, 3)
        return
      }
      // Ironblood: a real clash, not a mop-up.
      if (engagedCount >= profile.clashMin && foeHp >= ownHp * HORN_CLASH_FOE_FRACTION) {
        this.emitWarHorn(world, 2)
        return
      }
      // Gale March: the pre-battle slot — speed for the approach. The
      // expander's is coupled to the shrine sortie contestShrine
      // dispatched this think; any personality spends it on a wave
      // already marching to contact.
      if ((this.personality === 'expander' && this.shrineSortie) || advancing) {
        this.emitWarHorn(world, 1)
        return
      }
    }

    // Anti-decay conversion: the meter fighting built is ~15 s from
    // Coward's Decay deleting it, and a wave is already marching —
    // convert certain loss into approach speed. Hard veto when no wave
    // advances (the army home and idle): firing buys nothing there.
    // This is also the defender's only sub-floor spend — its offensive
    // floor is a full meter, and decay respects no floors.
    if (advancing && world.tick - world.warLastTick[team] >= HORN_DECAY_WARN_TICKS) {
      this.emitWarHorn(world, 1)
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
    // Opening advance delay (pacing slice): even with the bell rung and
    // a wave ready, the first march waits for the per-personality floor.
    if (this.gameTime < OPENING_ADVANCE_DELAY_SEC[this.personality]) return
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
   * Battle micro — tactical retreat, wounded withdrawal, and ranged
   * kiting. Runs every think tick after attack/defend orders. Only
   * soldiers engaged AWAY from the base (beyond the defense radius) are
   * eligible; the home garrison always holds. Retreating units rally on
   * the hall, go idle on arrival, and rejoin the next wave the macro
   * layer sends. Kiting units step back from a closing melee and
   * re-engage from range once the move order completes.
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
        continue
      }
      // Ranged kiting: a visible enemy melee closing on this archer
      // gets a step back, not a stand-and-trade. Nearest melee wins;
      // ties break by lower entity id, like the other micro picks.
      if (world.kind[id] === KIND_RANGED) {
        let threat = NO_TARGET
        let bestD = Infinity
        for (const e of enemies) {
          if (world.kind[e] !== KIND_MELEE) continue
          const d = Math.hypot(world.positionX[e] - ux, world.positionZ[e] - uz)
          if (d <= KITE_TRIGGER && (d < bestD || (d === bestD && e < threat))) {
            bestD = d
            threat = e
          }
        }
        if (threat !== NO_TARGET) {
          // Always-be-shooting refinement: the step back is skipped
          // when it buys no survival — the closing melee is dying
          // (at/below KITE_DYING_FRACTION it falls to the local fight
          // before it arrives) or the local cluster is already won
          // decisively (the RETREAT_RATIO comparison inverted in our
          // favor, on the health sums computed above). A skipped kite
          // keeps the archer's arrows in the fight; every other kite
          // condition is unchanged.
          const threatDying =
            world.health[threat] <= world.maxHealth[threat] * KITE_DYING_FRACTION
          const clusterWon = foe > 0 && own >= foe * retreatRatio
          if (!threatDying && !clusterWon) {
            const tx = world.positionX[threat]
            const tz = world.positionZ[threat]
            let dx = ux - tx
            let dz = uz - tz
            if (Math.hypot(dx, dz) < 1e-6) {
              dx = 1
              dz = 0
            } else {
              const d = Math.hypot(dx, dz)
              dx /= d
              dz /= d
            }
            const clamp = (v: number): number => Math.max(-MAP_CLAMP, Math.min(MAP_CLAMP, v))
            this.emitMove(world, id, clamp(tx + dx * KITE_STANDOFF), clamp(tz + dz * KITE_STANDOFF))
          }
        }
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
