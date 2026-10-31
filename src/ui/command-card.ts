/** RTS-style command card: portrait, stats, and command grid per selection. */
import type { World } from '../core/World'
import {
  HARVEST_WOOD,
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_SMITHY,
  KIND_TREE,
  KIND_WORKER,
  KIND_WORKSHOP,
  MILITIA_DURATION_SEC,
  MILITIA_MUSTER_RADIUS,
  STATE_ATTACK,
  STATE_ATTACKMOVE,
  STATE_BUILD,
  STATE_GATHER,
  STATE_HOLD,
  STATE_MOVE,
  STATE_PATROL,
  STATE_RETURN,
  TEAM_PLAYER,
} from '../core/World'
import type { MilitiaRefusal } from '../core/World'
import { getUnits } from '../data/stats.ts'
import type { UnitType } from '../data/units.ts'
import { ORC_TIER_NAMES, TIER_UPGRADES, researchCost, researchRefusal, trainCostFor, trainRefusal, trainingStateFor, trainingQueueFor, upgradeRefusal } from '../systems/production.ts'
import type { RefusalReason } from '../systems/production.ts'
import { HORN_COST, warChargeAtLeast } from '../systems/warhorn.ts'
import { UPGRADES } from '../data/upgrades.ts'
import type { UpgradeType } from '../data/upgrades.ts'
import { buildersOnSite } from '../systems/gather.ts'
import { BUILDINGS } from '../data/buildings.ts'
import type { BuildingType } from '../data/buildings.ts'
import {
  BUILDING_REQUIRES,
  BUILDING_TYPE_BY_KIND,
  PLAYER_BUILDABLE,
  buildingPrereqMet,
  canAfford,
} from '../world/construction.ts'
import type { PlacementRefusal } from '../world/construction.ts'
import { FACTIONS } from '../data/factions.ts'
import type { FactionId } from '../data/factions.ts'

export interface CommandCardCallbacks {
  onMode(mode: 'move' | 'attack' | 'gather' | 'build' | 'patrol'): void
  onStop(): void
  onHold(): void
  onBuildType(type: string): void
  onTrain(type: string): void
  /**
   * Tap-to-cancel production: index -1 cancels the ACTIVE training
   * item; index >= 0 cancels that queue position (full refund either
   * way). Optional: without it the training row renders read-only.
   */
  onCancelTrain?(index: number): void
  onResearch(type: string): void
  onMilitia(): void
  onUpgrade(): void
  onWarHorn(rally: 1 | 2 | 3): void
  onSetRally?(): void
  /** Toggle the worker Build sub-menu inside the dashboard. */
  onToggleBuild?: () => void
}

/** Faction color for portrait background. */
function factionColor(world: World, id: number): string {
  const team = world.team[id] as 0 | 1
  const fid = world.factionOfTeam?.[team] ?? 'human'
  const colors = FACTIONS[fid]?.colors ?? [0x2f6fd6, 0xf5c542, 0xdfe8f5]
  return `#${colors[0].toString(16).padStart(6, '0')}`
}

function unitKindToType(kind: number): UnitType | null {
  if (kind === KIND_WORKER) return 'worker'
  if (kind === KIND_MELEE) return 'melee'
  if (kind === KIND_RANGED) return 'ranged'
  return null
}

function factionIdFor(world: World, team: number): FactionId {
  return world.factionOfTeam?.[team] ?? 'human'
}

/** Faction-aware display name, e.g. 'Peasant' for a human worker (game-soul canon). */
function factionUnitName(world: World, team: number, utype: UnitType): string {
  const fid = factionIdFor(world, team)
  return FACTIONS[fid]?.units[utype] ?? utype
}

/** Faction-aware unit label for the selected entity's owning team. */
function unitLabel(world: World, kind: number, id: number): string {
  const utype = unitKindToType(kind)
  if (!utype) return '?'
  return factionUnitName(world, world.team[id] as 0 | 1, utype)
}

function buildingLabel(kind: number): string {
  if (kind === KIND_HALL) return 'Town Hall'
  if (kind === KIND_BARRACKS) return 'Barracks'
  if (kind === KIND_ARCHERY) return 'Archery Range'
  if (kind === KIND_FARM) return 'Farm'
  if (kind === KIND_WORKSHOP) return 'Workshop'
  if (kind === KIND_SMITHY) return 'Smithy'
  return '?'
}

type CmdFn = (label: string, fn: () => void, disabled?: boolean, sub?: string, note?: string) => void

/**
 * Collapse a production queue into ordered display runs with duplicate
 * collapsing: [worker, worker, melee] → "Peasant ×2 · Footman".
 * Presentation only; faction names resolved for the viewing team.
 */
export function formatQueueRuns(world: World, team: number, queue: readonly UnitType[]): string {
  const runs: string[] = []
  let i = 0
  while (i < queue.length) {
    let j = i + 1
    while (j < queue.length && queue[j] === queue[i]) j += 1
    const n = j - i
    const name = factionUnitName(world, team, queue[i])
    runs.push(n > 1 ? `${name} ×${n}` : name)
    i = j
  }
  return runs.join(' · ')
}

/**
 * What a selected unit is DOING right now (basics slice 3, audit F8):
 * the card used to be a pure stat sheet — a worker mid-job and a
 * worker standing idle rendered identically, and the opening
 * auto-gather assignment was invisible. Read from the unit's own
 * state fields only: the sim state, its target node's kind for the
 * gather flavour, its harvest assignment as the fallback while a
 * target is being (re)acquired, and the militia window. Length
 * discipline: every string fits the 16-character ceiling the build
 * grid's note line measured (slice 2) — the tightest note geometry
 * on any card — so the line is safe at any card width.
 */
export function unitStateText(world: World, id: number): string {
  if (world.kind[id] === KIND_WORKER && world.isMilitia(id)) return 'On militia duty'
  switch (world.state[id]) {
    case STATE_GATHER: {
      const target = world.targetId[id]
      const targetKind = target >= 0 ? world.kind[target] : -1
      if (targetKind === KIND_GOLDMINE) return 'Gathering gold'
      if (targetKind === KIND_TREE) return 'Gathering wood'
      return world.harvestKind[id] === HARVEST_WOOD ? 'Gathering wood' : 'Gathering gold'
    }
    case STATE_RETURN: return 'Returning'
    case STATE_ATTACK: return 'Fighting'
    case STATE_BUILD: return 'Building'
    case STATE_HOLD: return 'Holding'
    case STATE_MOVE:
    case STATE_ATTACKMOVE:
    case STATE_PATROL: return 'Moving'
    default: return 'Idle'
  }
}

/**
 * The Militia Bell's real terms (basics slice 3, audit F6): radius
 * and duration read from the militia system's own constants — the
 * same values World.ringMilitiaBell enforces — plus the gathering
 * freeze the ring imposes (militia drop their cargo and stop).
 */
export const BELL_TERMS_TEXT =
  `🔔 Bell: Peasants within ${MILITIA_MUSTER_RADIUS} fight for ${MILITIA_DURATION_SEC}s — gathering stops`

/** Banner text for a refused Militia Bell ring (audit F6): the
 * reason comes from World.militiaRefusal — ringMilitiaBell's own
 * guard chain — this only phrases it. */
export function militiaRefusalBannerText(reason: MilitiaRefusal): string {
  switch (reason) {
    case 'none-in-radius': return `No Peasants within ${MILITIA_MUSTER_RADIUS} of the Hall`
    case 'cooldown': return 'The Bell is still recharging'
    case 'no-hall': return 'No Town Hall standing'
    case 'unavailable': return 'Not available here'
  }
}

/** Banner text for a refused placement tap (basics slice 3, audit
 * F10): the reason comes from placementRefusal — canPlaceStructure's
 * own checks — this only phrases it. `type` is the building the
 * player was placing (the prereq line names its gate from
 * BUILDING_REQUIRES, the same table the check reads). */
export function placementRefusalBannerText(
  reason: PlacementRefusal,
  type: BuildingType,
): string {
  switch (reason.kind) {
    case 'gold': return `Need ${reason.short} more gold`
    case 'wood': return `Need ${reason.short} more wood`
    case 'prereq': {
      const req = BUILDING_REQUIRES[type]
      return req ? `Requires a finished ${BUILDINGS[req].name}` : 'Locked by tech'
    }
    case 'blocked-unit': return reason.own ? 'Your own unit is standing there' : 'A unit is standing there'
    case 'blocked': return 'Blocked — pick another spot'
    case 'faction-rule': return 'Your faction cannot raise this'
  }
}

/**
 * The worker Build sub-menu buttons (build options + Back), shared by the
 * single-worker card and the all-worker group card so the two can never
 * drift apart.
 */
/**
 * Short command-card names for build buttons: state text must never
 * truncate at phone widths (UX-audit acceptance data measured
 * 'Archery Range' and 'Guard Tower' ellipsizing in the Build menu).
 * The full names stay in the data tables (pills, How to Play).
 */
const BUILD_BUTTON_LABELS: Record<string, string> = {
  hall: 'Hall',
  farm: 'Farm',
  barracks: 'Barracks',
  archery: 'Archery',
  tower: 'Tower',
  workshop: 'Workshop',
  smithy: 'Smithy',
}

/**
 * Player-facing text for a production refusal (basics slice 2, audit
 * F5). Two forms over the one RefusalReason the sim's own guard chain
 * computed — short for a button's note line, full for the banner lane.
 * No rule lives here: the reason (and the shortfall amount) comes from
 * production.ts; this only phrases it.
 */
export function refusalShortText(reason: RefusalReason): string {
  switch (reason.kind) {
    // Compact delta form: the note line is 84px of 9px text at phone
    // widths, and the full 'Need N more wood' sentence ellipsized by
    // a character (frame-measured, basics slice 2). On a disabled
    // price button the delta alone is unambiguous; the banner lane
    // carries the full sentence.
    case 'gold': return `${reason.short} more gold`
    case 'wood': return `${reason.short} more wood`
    case 'supply': return 'Supply full'
    case 'queue-full': return 'Queue full'
    case 'needs-archery': return 'Requires Archery Range'
    case 'unfinished': return 'Under construction'
    case 'mid-upgrade': return 'Upgrading'
    case 'max-level': return 'Max level'
    case 'unavailable': return ''
  }
}

export function refusalBannerText(
  world: World,
  team: number,
  reason: RefusalReason,
  context: 'train' | 'research' | 'upgrade',
): string {
  switch (reason.kind) {
    case 'gold': return `Need ${reason.short} more gold`
    case 'wood': return `Need ${reason.short} more wood`
    case 'supply':
      // The advice must be true for the tapping team: undead raise no
      // farms — their cap grows through Soul-Ash — so they get the
      // bare fact instead of a farm tip that cannot work for them.
      return world.factionOfTeam[team] === 'undead'
        ? 'Supply full'
        : 'Supply full — build a Farm'
    case 'queue-full': return 'Queue full'
    case 'needs-archery': return 'Requires a finished Archery Range'
    case 'unfinished': return 'Still under construction'
    case 'mid-upgrade':
      return context === 'upgrade'
        ? 'Already upgrading'
        : context === 'research'
          ? 'Upgrading — research paused'
          : 'Upgrading — training paused'
    case 'max-level':
      return context === 'upgrade' ? 'Already at top tier' : 'Already at max level'
    case 'unavailable': return 'Not available here'
  }
}

/**
 * What a build-menu entry is FOR, in one short line (basics audit F9:
 * the menu sold prices, not purposes). Every claim derives from the
 * data tables and the systems that consume them: the Farm's grant is
 * the table's supply value (never a literal — the +8-for-+6 label bug
 * is the standing lesson), the Workshop's line names the two entries
 * BUILDING_REQUIRES gates on it, the Archery Range's line names the
 * Barracks unlock enqueueTrain enforces, the Tower's line is the
 * combat system's tower fire.
 */
function buildPurpose(btype: BuildingType): string {
  const bdef = BUILDINGS[btype]
  switch (btype) {
    // Length discipline: the note line is 84px of 9px text in the
    // build grid — 16 characters is the measured ceiling before the
    // ellipsis eats the end (frame proof, basics slice 2). Every
    // string below fits it; lengthen one and the frame proof fails.
    case 'hall': return 'Trains workers'
    case 'farm': return `Supply +${bdef.supply}`
    case 'barracks': return 'Trains soldiers'
    case 'archery': return 'Unlocks archers'
    case 'tower': return 'Shoots enemies'
    case 'workshop': return 'Unlocks tech'
    case 'smithy': return 'Weapon + Armor'
  }
}

/** The binding shortfall for an unaffordable build entry, phrased like
 * the refusal reasons (the audit's F5 moment B: greyed entries showed
 * the price but never what was missing). */
function buildShortfallNote(world: World, btype: BuildingType): string {
  const cost = BUILDINGS[btype].cost
  const goldShort = Math.ceil(cost.gold - world.gold[TEAM_PLAYER])
  const woodShort = Math.ceil(cost.wood - world.wood[TEAM_PLAYER])
  if (goldShort > 0 && woodShort > 0) return `${goldShort}g + ${woodShort}w more`
  if (goldShort > 0) return `${goldShort} more gold`
  return `${woodShort} more wood`
}

/**
 * One build-menu entry, shared by the expander menu and the inline
 * fallback so the two can never drift apart. Tech-locked entries
 * (Smithy / Archery Range before a finished Workshop) still render —
 * the fixed-grid invariant: cells never appear or disappear — greyed,
 * with the price always visible (players plan around prices) and the
 * binding fact on its own third line: the lock when gated, the
 * shortfall when unaffordable, otherwise what the building is for
 * (audit F9). The note line renders for every build entry so locked
 * and unlocked cells have identical geometry. placeStructure enforces
 * the same gate in the sim.
 */
function appendBuildButton(cmd: CmdFn, world: World, cb: CommandCardCallbacks, btype: BuildingType): void {
  const bdef = BUILDINGS[btype]
  const req = BUILDING_REQUIRES[btype]
  const locked = req !== undefined && !buildingPrereqMet(world, TEAM_PLAYER, btype)
  const afford = canAfford(world, TEAM_PLAYER, btype)
  const sub = `${bdef.cost.gold}g ${bdef.cost.wood}w`
  const note = locked && req !== undefined
    ? `Needs ${BUILDINGS[req].name}`
    : !afford
      ? buildShortfallNote(world, btype)
      : buildPurpose(btype)
  cmd(BUILD_BUTTON_LABELS[btype] ?? bdef.name, () => cb.onBuildType(btype), locked || !afford, sub, note)
}

/** One research ladder button (Smithy Weapon/Armor, Archery Ranged). */
function appendResearchButton(
  cmd: CmdFn,
  world: World,
  cb: CommandCardCallbacks,
  buildingId: number,
  type: UpgradeType,
  label: string,
): void {
  const price = researchCost(world, TEAM_PLAYER, type)
  const refusal = researchRefusal(world, buildingId, type)
  const sub = `${price.gold}g ${price.wood}w`
  if (refusal?.kind === 'gold' || refusal?.kind === 'wood') {
    cmd(label, () => cb.onResearch(type), true, sub, refusalShortText(refusal))
  } else if (refusal?.kind === 'unfinished') {
    cmd(label, () => cb.onResearch(type), false, sub, refusalShortText(refusal))
  } else {
    cmd(label, () => cb.onResearch(type), false, sub)
  }
}

function appendBuildButtons(cmd: CmdFn, world: World, cb: CommandCardCallbacks): void {
  for (const btype of PLAYER_BUILDABLE) {
    // Undead raise no farms — Soul-Ash feeds their supply cap.
    if (btype === 'farm' && world.factionOfTeam[TEAM_PLAYER] === 'undead') continue
    appendBuildButton(cmd, world, cb, btype)
  }
  cmd('◀ Back', () => cb.onToggleBuild?.())
}

/**
 * Render a command card into `el` for the given selection.
 * Returns true if a card was rendered, false for empty selection.
 *
 * Layout: this renders into the bottom dashboard — one identity row
 * (portrait chip, name, HP bar), one compact stat LINE (no grid), and a
 * single row of unit-specific command buttons. For workers, Build is an
 * expander: `opts.buildOpen` swaps the command row for the build options
 * (plus Back) in the same dashboard space.
 *
 * A multi-unit selection of own units renders the GROUP card instead
 * (counts by class, aggregate HP, union command row) — see
 * renderGroupCard. Single-selection rendering is unchanged.
 */
export function renderCommandCard(
  el: HTMLElement,
  world: World,
  selected: number[],
  cb: CommandCardCallbacks,
  opts?: { buildOpen?: boolean },
): boolean {
  el.innerHTML = ''
  if (selected.length === 0) return false

  if (selected.length > 1) {
    const allOwnUnits = selected.every((sid) => {
      const k = world.kind[sid]
      return (
        world.team[sid] === TEAM_PLAYER &&
        (k === KIND_WORKER || k === KIND_MELEE || k === KIND_RANGED)
      )
    })
    if (allOwnUnits) return renderGroupCard(el, world, selected, cb, opts)
  }

  const id = selected[0]
  const kind = world.kind[id]
  const isOwn = world.team[id] === TEAM_PLAYER
  const isUnit = kind === KIND_WORKER || kind === KIND_MELEE || kind === KIND_RANGED
  const isBuilding =
    kind === KIND_HALL || kind === KIND_BARRACKS || kind === KIND_ARCHERY || kind === KIND_FARM ||
    kind === KIND_WORKSHOP || kind === KIND_SMITHY
  const isResource = kind === KIND_TREE || kind === KIND_GOLDMINE

  const card = document.createElement('div')
  card.className = 'cmd-card'
  card.style.pointerEvents = 'auto'

  // --- Header: portrait + name + HP ---
  const header = document.createElement('div')
  header.className = 'cmd-header'

  const portrait = document.createElement('div')
  portrait.className = 'cmd-portrait'
  portrait.style.background = factionColor(world, id)
  const initial = isResource
    ? (kind === KIND_TREE ? '🌲' : '⛏')
    : isUnit
      ? unitLabel(world, kind, id)[0]
      : buildingLabel(kind)[0]
  portrait.textContent = initial
  header.appendChild(portrait)

  const titleWrap = document.createElement('div')
  titleWrap.className = 'cmd-title-wrap'
  const title = document.createElement('div')
  title.className = 'cmd-title'
  const ownerPrefix = !isOwn && !isResource ? 'Enemy ' : ''
  title.textContent =
    ownerPrefix +
    (isResource
      ? kind === KIND_TREE
        ? 'Tree'
        : 'Gold Mine'
      : isUnit
        ? unitLabel(world, kind, id)
        : buildingLabel(kind)) +
    (selected.length > 1 ? ` ×${selected.length}` : '')
  titleWrap.appendChild(title)

  // HP bar for units/buildings
  if (isUnit || isBuilding) {
    const hp = Math.max(0, Math.floor(world.health[id]))
    const maxHp = Math.floor(world.maxHealth[id])
    const hpWrap = document.createElement('div')
    hpWrap.className = 'cmd-hpbar'
    const hpFill = document.createElement('div')
    hpFill.className = 'cmd-hpfill'
    hpFill.style.width = `${maxHp > 0 ? (hp / maxHp) * 100 : 0}%`
    hpFill.style.background = hp / maxHp > 0.5 ? '#4ade80' : hp / maxHp > 0.25 ? '#facc15' : '#ef4444'
    hpWrap.appendChild(hpFill)
    const hpText = document.createElement('div')
    hpText.className = 'cmd-hptext'
    hpText.textContent = `${hp}/${maxHp}`
    titleWrap.appendChild(hpWrap)
    titleWrap.appendChild(hpText)
  }
  header.appendChild(titleWrap)
  card.appendChild(header)

  // --- Compact stat line: one small-text row. The old 3-column grid of
  // stat boxes was half the reason the card rendered as a big block. ---
  const parts: string[] = []
  if (isUnit) {
    const utype: UnitType =
      kind === KIND_WORKER ? 'worker' : kind === KIND_MELEE ? 'melee' : 'ranged'
    const def = getUnits()[utype]
    // The cost shown is the price the unit's OWN team actually pays —
    // trainCostFor (faction cost modifier applied), the same helper
    // production charges. The raw table cost lied to every faction
    // with a cost modifier (undead, elf, orc, ...).
    const price = trainCostFor(world, world.team[id] as 0 | 1, utype)
    parts.push(
      `Dmg ${def.damage}`,
      `Rng ${def.range}`,
      `Sight ${def.sight}`,
      `Spd ${def.speed ?? '—'}`,
      `Arm ${(def as { armor?: number }).armor ?? 0}`,
      `${price.gold}g ${price.wood}w`,
    )
  } else if (isBuilding) {
    const btype = BUILDING_TYPE_BY_KIND[kind]
    const bdef = btype ? BUILDINGS[btype] : undefined
    if (bdef) {
      parts.push(`HP ${Math.floor(world.health[id])}/${Math.floor(world.maxHealth[id])}`)
      // Derived from the building data, never a literal: the farm card
      // read 'Supply +8' for a +6 farm until the label was fixed by
      // hand (2026-10-26); deriving it makes that class of lie
      // impossible to reintroduce.
      if (kind === KIND_FARM) parts.push(`Supply +${bdef.supply}`)
      // Trainable units, from the data table (the Archery Range trains
      // nothing since the tech rework — it unlocks and researches).
      const trainable = bdef.trains
      if (trainable.length > 0) parts.push(`Trains ${trainable.map((t) => factionUnitName(world, TEAM_PLAYER, t)).join(', ')}`)
    }
  } else if (isResource) {
    const res = kind === KIND_TREE ? 'Wood' : 'Gold'
    parts.push(res, `${Math.floor(world.amount[id])} left`)
  }
  if (parts.length > 0) {
    const line = document.createElement('div')
    line.className = 'cmd-statline'
    line.textContent = parts.join(' · ')
    card.appendChild(line)
  }

  // --- Unit state line (basics slice 3, audit F8): what the selected
  // unit is doing right now, read from its own state fields — the
  // line that makes the opening auto-gather assignment, a return
  // trip, or a fight visible on the card instead of guessable only
  // by watching the unit. ---
  if (isUnit) {
    const stateLine = document.createElement('div')
    stateLine.className = 'cmd-statline'
    stateLine.textContent = unitStateText(world, id)
    card.appendChild(stateLine)
  }

  // --- Militia Bell terms (basics slice 3, audit F6): the hall card
  // states the Bell's radius, duration, and gathering freeze BEFORE
  // the first ring — the audit's cold player mustered blind and
  // froze his whole economy for 25s without a word of warning. ---
  if (isOwn && isBuilding && kind === KIND_HALL && world.factionOfTeam[world.team[id] as 0 | 1] === 'human') {
    const bellLine = document.createElement('div')
    bellLine.className = 'cmd-statline'
    bellLine.textContent = BELL_TERMS_TEXT
    card.appendChild(bellLine)
  }

  // --- Construction state: an unfinished structure shows its progress
  // and (for our own) how many builders are on it. The multi-builder
  // mechanic is invisible without this, and invisible mechanics read
  // as bugs. All numbers are sim state, read-only. ---
  if (isBuilding && world.buildProgress[id] < world.buildTotal[id]) {
    const pct = Math.floor((world.buildProgress[id] / world.buildTotal[id]) * 100)
    const line = document.createElement('div')
    line.className = 'cmd-statline'
    const builders = isOwn ? buildersOnSite(world, id) : 0
    line.textContent =
      builders > 0
        ? `🔨 ${builders} builder${builders > 1 ? 's' : ''} · ${pct}% built`
        : `🔨 Under construction · ${pct}% built`
    card.appendChild(line)
  }

  // --- Training state (own production buildings): the active item
  // with its real progress bar + seconds remaining, and the queue
  // behind it as an ordered row with duplicates collapsed. Progress
  // conventions: bar + countdown on the ACTIVE item only. With a
  // cancel callback wired, the active item and each queue run are
  // buttons — tapping cancels (full refund). ---
  if (isOwn && isBuilding) {
    const train = trainingStateFor(world, id)
    if (train) {
      const wrap = document.createElement('div')
      wrap.className = 'cmd-train'
      const labelText = `Training ${factionUnitName(world, TEAM_PLAYER, train.type)} · ${Math.ceil(train.secondsLeft)}s left`
      if (cb.onCancelTrain) {
        const cancelBtn = document.createElement('button')
        cancelBtn.className = 'cmd-train-label cmd-train-cancel'
        cancelBtn.textContent = `${labelText} ✕`
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          e.preventDefault()
          cb.onCancelTrain!(-1)
        })
        wrap.appendChild(cancelBtn)
      } else {
        const label = document.createElement('div')
        label.className = 'cmd-train-label'
        label.textContent = labelText
        wrap.appendChild(label)
      }
      const bar = document.createElement('div')
      bar.className = 'cmd-hpbar cmd-trainbar'
      const fill = document.createElement('div')
      fill.className = 'cmd-hpfill cmd-trainfill'
      fill.style.width = `${train.fraction * 100}%`
      bar.appendChild(fill)
      wrap.appendChild(bar)
      const queue = trainingQueueFor(world, id)
      if (queue.length > 0) {
        if (cb.onCancelTrain) {
          // Tappable run chips: duplicates stay collapsed (×N), and a
          // tap cancels ONE item — the last of the tapped run.
          const q = document.createElement('div')
          q.className = 'cmd-train-queue cmd-train-chips'
          const head = document.createElement('span')
          head.className = 'cmd-train-chiphead'
          head.textContent = 'Queued:'
          q.appendChild(head)
          let i = 0
          while (i < queue.length) {
            let j = i + 1
            while (j < queue.length && queue[j] === queue[i]) j += 1
            const n = j - i
            const name = factionUnitName(world, TEAM_PLAYER, queue[i])
            const cancelIndex = j - 1
            const chip = document.createElement('button')
            chip.className = 'cmd-train-chip'
            chip.textContent = n > 1 ? `${name} ×${n}` : name
            chip.addEventListener('click', (e) => {
              e.stopPropagation()
              e.preventDefault()
              cb.onCancelTrain!(cancelIndex)
            })
            q.appendChild(chip)
            i = j
          }
          wrap.appendChild(q)
        } else {
          const q = document.createElement('div')
          q.className = 'cmd-train-queue'
          q.textContent = `Queued: ${formatQueueRuns(world, TEAM_PLAYER, queue)}`
          wrap.appendChild(q)
        }
      }
      card.appendChild(wrap)
    }
  }

  // --- Command grid (own units/buildings only) ---
  if (isOwn && (isUnit || isBuilding)) {
    const grid = document.createElement('div')
    grid.className = 'cmd-grid'

    const cmd = (label: string, fn: () => void, disabled = false, sub?: string, note?: string): void => {
      const btn = document.createElement('button')
      btn.className = 'cmd-btn'
      btn.disabled = disabled
      const lbl = document.createElement('span')
      lbl.className = 'cmd-btn-label'
      lbl.textContent = label
      btn.appendChild(lbl)
      if (sub) {
        const s = document.createElement('span')
        s.className = 'cmd-btn-sub'
        s.textContent = sub
        btn.appendChild(s)
      }
      if (note !== undefined) {
        const n = document.createElement('span')
        n.className = 'cmd-btn-note'
        n.textContent = note
        btn.appendChild(n)
      }
      btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn() })
      grid.appendChild(btn)
    }

    if (isUnit) {
      if (kind === KIND_WORKER && opts?.buildOpen && cb.onToggleBuild) {
        // Build sub-menu: the build options replace the command row inside
        // the same dashboard space (never a second stacked panel). The
        // build grid wraps to four-across rows so every name, price and
        // lock note fits its own cell in full (see .cmd-grid-build).
        grid.className = 'cmd-grid cmd-grid-build'
        appendBuildButtons(cmd, world, cb)
      } else {
        cmd('Move', () => cb.onMode('move'))
        cmd('Attack', () => cb.onMode('attack'))
        cmd('Stop', () => cb.onStop())
        if (kind === KIND_WORKER) {
          cmd('Gather', () => cb.onMode('gather'))
          if (cb.onToggleBuild) {
            cmd('Build ▸', () => cb.onToggleBuild?.())
          } else {
            // No expander wired: list build options inline (legacy shape,
            // same wrapped build grid so the entries stay readable).
            grid.className = 'cmd-grid cmd-grid-build'
            for (const btype of PLAYER_BUILDABLE) {
              if (btype === 'farm' && world.factionOfTeam[TEAM_PLAYER] === 'undead') continue
              appendBuildButton(cmd, world, cb, btype)
            }
          }
        } else {
          cmd('Patrol', () => cb.onMode('patrol'))
          cmd('Hold', () => cb.onHold())
        }
      }
    } else if (isBuilding) {
      // Train buttons, from the building's data-table roster. The
      // Barracks hires both melee and ranged since the tech rework —
      // but the ranged button is the Archery Range's unlock: always
      // rendered (fixed-grid invariant), greyed with the requirement
      // until a finished Range stands. enqueueTrain enforces the same
      // gate in the sim.
      const btype = BUILDING_TYPE_BY_KIND[kind]
      const trainable: UnitType[] = btype ? BUILDINGS[btype].trains : []
      for (const utype of trainable) {
        // Price from trainCostFor — the exact price enqueueTrain
        // charges this team (faction modifier applied) — and the
        // button state from trainRefusal, the sim's own guard chain,
        // so the card can never disagree with the tap's verdict:
        //  - the Archery gate and a resource shortfall disable the
        //    button, with the binding fact on the note line;
        //  - supply / queue-full / unfinished / mid-upgrade leave the
        //    button LIVE, its note naming the state, so the tap itself
        //    surfaces the reason in the banner lane (main.ts onTrain)
        //    — a disabled button fires nothing, not even the reason.
        const price = trainCostFor(world, TEAM_PLAYER, utype)
        const refusal = trainRefusal(world, id, utype)
        const name = factionUnitName(world, TEAM_PLAYER, utype)
        const priceSub = `${price.gold}g ${price.wood}w`
        if (refusal?.kind === 'needs-archery') {
          cmd(name, () => cb.onTrain(utype), true, 'Requires Archery Range')
        } else if (refusal?.kind === 'gold' || refusal?.kind === 'wood') {
          cmd(name, () => cb.onTrain(utype), true, priceSub, refusalShortText(refusal))
        } else if (refusal?.kind === 'unavailable') {
          cmd(name, () => cb.onTrain(utype), true, priceSub)
        } else if (refusal) {
          cmd(name, () => cb.onTrain(utype), false, priceSub, refusalShortText(refusal))
        } else {
          cmd(name, () => cb.onTrain(utype), false, priceSub)
        }
      }
      // Upgrade buttons. Prices come from researchCost — the helper
      // researchUpgrade charges and the AI's research gate floors on.
      // The card used to hardcode the base '100g 50w': for human (the
      // default faction) the Adaptable signature charges 80g/40w, so
      // the label overstated the price AND the button stayed disabled
      // until the player held the full base cost. Button state now
      // comes from researchRefusal (the sim's own guards): a resource
      // shortfall disables with the missing amount on the note line;
      // an unfinished building's button stays live so the tap names
      // the reason in the banner lane (main.ts onResearch).
      if (kind === KIND_SMITHY) {
        const ladders: Array<{ type: UpgradeType; lvl: number; label: string }> = [
          { type: 'meleeDmg', lvl: world.meleeDmgLvl[TEAM_PLAYER], label: 'Weapon' },
          { type: 'meleeHp', lvl: world.meleeHpLvl[TEAM_PLAYER], label: 'Armor' },
        ]
        for (const { type, lvl, label } of ladders) {
          if (lvl >= UPGRADES[type].maxLevel) continue
          appendResearchButton(cmd, world, cb, id, type, `${label} +${lvl + 1}`)
        }
      }
      if (kind === KIND_ARCHERY) {
        const lvl = world.rangedDmgLvl[TEAM_PLAYER]
        if (lvl < UPGRADES.rangedDmg.maxLevel) {
          appendResearchButton(cmd, world, cb, id, 'rangedDmg', `Ranged +${lvl + 1}`)
        }
      }
      // Militia Bell (human racial): muster nearby peasants as Levy Pikemen.
      // Button label is the short 'Bell': the full 'Militia Bell' name
      // ellipsized at phone card widths (UX-audit acceptance data).
      if (kind === KIND_HALL && world.factionOfTeam[TEAM_PLAYER] === 'human') {
        const onCooldown = world.matchTime < world.militiaCooldown[TEAM_PLAYER]
        cmd(
          onCooldown ? '🔔 Bell (cd)' : '🔔 Bell',
          () => cb.onMilitia(),
          onCooldown,
          undefined,
          // The cost half of the Bell's terms rides the button itself
          // (radius + duration are on the card's terms line above).
          // Short form: 'Gathering stops' ellipsized in this cell at
          // 412px (frame-measured, basics slice 3) — the full wording
          // lives on the terms line, this is its flag.
          'No gathering',
        )
      }
      // Orc in-place upgrading: reforge the War-Hall / Foundry through 3 tiers.
      if ((kind === KIND_HALL || kind === KIND_BARRACKS) && world.factionOfTeam[TEAM_PLAYER] === 'orc') {
        const tier = world.tier[id]
        if (tier < 3) {
          // Cost read from production's TIER_UPGRADES (the table
          // upgradeBuilding charges) — no duplicated literals — and
          // the button state from upgradeRefusal, so a shortfall
          // disables with the missing amount on the note line.
          const cost = TIER_UPGRADES[tier]
          const refusal = upgradeRefusal(world, id)
          const upgrading = world.upgradeLeft[id] > 0
          const label = upgrading
            ? `Upgrading…`
            : `⬆ ${ORC_TIER_NAMES[tier]}`
          const shortfall = refusal?.kind === 'gold' || refusal?.kind === 'wood'
            ? refusalShortText(refusal)
            : undefined
          cmd(label, () => cb.onUpgrade(), upgrading || shortfall !== undefined, upgrading ? undefined : `${cost.gold}g ${cost.wood}w`, shortfall)
        }
      }
      // War Horn: sound a rally when the horn is charged (all races).
      if (kind === KIND_HALL) {
        const charge = Math.floor(world.warCharge[TEAM_PLAYER])
        const rallying = world.rallyKind[TEAM_PLAYER] !== 0 && world.rallyUntil[TEAM_PLAYER] > world.matchTime
        // Short labels (UX-audit acceptance data): the full rally
        // names ellipsized to 'Gale …' / 'Iron…' / 'Seco…' at card
        // widths, leaving the three horns indistinguishable. The
        // emoji + short name keep them distinct; full names live in
        // How to Play and the warhorn system.
        const labels: Record<number, string> = { 1: '🌪 Gale', 2: '🩸 Iron', 3: '💨 Wind' }
        for (const r of [1, 2, 3] as const) {
          // Readiness uses the sim's own threshold predicate on the raw
          // charge, not the floored label value: at 49.9999999999993
          // (1000 damage in 1-damage increments) the floor reads 49 but
          // the horn IS soundable (tester E2).
          const ready = warChargeAtLeast(world, TEAM_PLAYER, HORN_COST) && !rallying
          cmd(
            labels[r],
            () => cb.onWarHorn(r),
            !ready,
            ready ? `${charge}` : undefined,
          )
        }
      }
      if (cb.onSetRally) cmd('Rally', () => cb.onSetRally!())
    }

    if (grid.children.length > 0) card.appendChild(grid)
  }

  el.appendChild(card)
  return true
}

/**
 * Group card for a multi-unit selection (marquee, idle-workers, or
 * type-select): same dashboard footprint as the single card — identity
 * row, one stat line, one command row — but the identity is the GROUP:
 * unit count, per-class counts with faction names, and an aggregate HP
 * bar (sum over the group, so it visibly drains as the group takes
 * damage). The command row is the union of what the group's classes can
 * do — Move/Attack/Stop for everyone, Gather when any worker is in the
 * group, Patrol/Hold when any military is — and every button drives the
 * EXISTING whole-selection order paths (input modes, stop, hold), so a
 * group order fans out through the same order types as a single order.
 * An all-worker group also keeps the Build ▸ expander, preserving the
 * idle-workers → build flow.
 */
function renderGroupCard(
  el: HTMLElement,
  world: World,
  selected: number[],
  cb: CommandCardCallbacks,
  opts?: { buildOpen?: boolean },
): boolean {
  const counts = new Map<number, number>()
  let hpSum = 0
  let maxSum = 0
  for (const sid of selected) {
    counts.set(world.kind[sid], (counts.get(world.kind[sid]) ?? 0) + 1)
    hpSum += Math.max(0, Math.floor(world.health[sid]))
    maxSum += Math.floor(world.maxHealth[sid])
  }
  const nWorkers = counts.get(KIND_WORKER) ?? 0
  const nMelee = counts.get(KIND_MELEE) ?? 0
  const nRanged = counts.get(KIND_RANGED) ?? 0
  const anyMilitary = nMelee + nRanged > 0
  const allWorkers = nWorkers === selected.length

  const card = document.createElement('div')
  card.className = 'cmd-card'
  card.style.pointerEvents = 'auto'

  // --- Header: group chip + count + aggregate HP ---
  const header = document.createElement('div')
  header.className = 'cmd-header'
  const portrait = document.createElement('div')
  portrait.className = 'cmd-portrait'
  portrait.style.background = factionColor(world, selected[0])
  portrait.textContent = '👥'
  header.appendChild(portrait)

  const titleWrap = document.createElement('div')
  titleWrap.className = 'cmd-title-wrap'
  const title = document.createElement('div')
  title.className = 'cmd-title'
  title.textContent = `${selected.length} units`
  titleWrap.appendChild(title)

  const hpWrap = document.createElement('div')
  hpWrap.className = 'cmd-hpbar'
  const hpFill = document.createElement('div')
  hpFill.className = 'cmd-hpfill'
  const ratio = maxSum > 0 ? hpSum / maxSum : 0
  hpFill.style.width = `${ratio * 100}%`
  hpFill.style.background = ratio > 0.5 ? '#4ade80' : ratio > 0.25 ? '#facc15' : '#ef4444'
  hpWrap.appendChild(hpFill)
  const hpText = document.createElement('div')
  hpText.className = 'cmd-hptext'
  hpText.textContent = `${hpSum}/${maxSum}`
  titleWrap.appendChild(hpWrap)
  titleWrap.appendChild(hpText)
  header.appendChild(titleWrap)
  card.appendChild(header)

  // --- Stat line: counts by class, faction names ---
  const classParts: string[] = []
  for (const [kind, n] of [
    [KIND_WORKER, nWorkers],
    [KIND_MELEE, nMelee],
    [KIND_RANGED, nRanged],
  ] as const) {
    if (n === 0) continue
    const utype = unitKindToType(kind)
    if (utype) classParts.push(`${n} ${factionUnitName(world, TEAM_PLAYER, utype)}`)
  }
  const line = document.createElement('div')
  line.className = 'cmd-statline'
  line.textContent = classParts.join(' · ')
  card.appendChild(line)

  // --- Command row: the union of the group's class commands ---
  const grid = document.createElement('div')
  grid.className = 'cmd-grid'
  const cmd: CmdFn = (label, fn, disabled = false, sub, note) => {
    const btn = document.createElement('button')
    btn.className = 'cmd-btn'
    btn.disabled = disabled
    const lbl = document.createElement('span')
    lbl.className = 'cmd-btn-label'
    lbl.textContent = label
    btn.appendChild(lbl)
    if (sub) {
      const s = document.createElement('span')
      s.className = 'cmd-btn-sub'
      s.textContent = sub
      btn.appendChild(s)
    }
    if (note !== undefined) {
      const n = document.createElement('span')
      n.className = 'cmd-btn-note'
      n.textContent = note
      btn.appendChild(n)
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn() })
    grid.appendChild(btn)
  }

  if (allWorkers && opts?.buildOpen && cb.onToggleBuild) {
    grid.className = 'cmd-grid cmd-grid-build'
    appendBuildButtons(cmd, world, cb)
  } else {
    cmd('Move', () => cb.onMode('move'))
    cmd('Attack', () => cb.onMode('attack'))
    cmd('Stop', () => cb.onStop())
    if (nWorkers > 0) cmd('Gather', () => cb.onMode('gather'))
    if (anyMilitary) {
      cmd('Patrol', () => cb.onMode('patrol'))
      cmd('Hold', () => cb.onHold())
    }
    if (allWorkers && cb.onToggleBuild) cmd('Build ▸', () => cb.onToggleBuild?.())
  }
  card.appendChild(grid)

  el.appendChild(card)
  return true
}
