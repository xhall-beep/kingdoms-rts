/** RTS-style command card: portrait, stats, and command grid per selection. */
import type { World } from '../core/World'
import {
  KIND_ARCHERY,
  KIND_BARRACKS,
  KIND_FARM,
  KIND_GOLDMINE,
  KIND_HALL,
  KIND_MELEE,
  KIND_RANGED,
  KIND_TREE,
  KIND_WORKER,
  TEAM_PLAYER,
} from '../core/World'
import { getUnits } from '../data/stats.ts'
import type { UnitType } from '../data/units.ts'
import { ORC_TIER_NAMES, trainingStateFor, trainingQueueFor } from '../systems/production.ts'
import { buildersOnSite } from '../systems/gather.ts'
import { BUILDINGS } from '../data/buildings.ts'
import { PLAYER_BUILDABLE, canAfford } from '../world/construction.ts'
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
  return '?'
}

type CmdFn = (label: string, fn: () => void, disabled?: boolean, sub?: string) => void

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
}

function appendBuildButtons(cmd: CmdFn, world: World, cb: CommandCardCallbacks): void {
  for (const btype of PLAYER_BUILDABLE) {
    // Undead raise no farms — Soul-Ash feeds their supply cap.
    if (btype === 'farm' && world.factionOfTeam[TEAM_PLAYER] === 'undead') continue
    const bdef = BUILDINGS[btype]
    const afford = canAfford(world, TEAM_PLAYER, btype)
    cmd(BUILD_BUTTON_LABELS[btype] ?? bdef.name, () => cb.onBuildType(btype), !afford, `${bdef.cost.gold}g ${bdef.cost.wood}w`)
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
    kind === KIND_HALL || kind === KIND_BARRACKS || kind === KIND_ARCHERY || kind === KIND_FARM
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
    parts.push(
      `Dmg ${def.damage}`,
      `Rng ${def.range}`,
      `Sight ${def.sight}`,
      `Spd ${def.speed ?? '—'}`,
      `Arm ${(def as { armor?: number }).armor ?? 0}`,
      `${def.cost.gold}g ${def.cost.wood}w`,
    )
  } else if (isBuilding) {
    const btype = kind === KIND_HALL ? 'hall' : kind === KIND_BARRACKS ? 'barracks' : kind === KIND_ARCHERY ? 'archery' : 'farm'
    const bdef = BUILDINGS[btype as keyof typeof BUILDINGS]
    if (bdef) {
      parts.push(`HP ${Math.floor(world.health[id])}/${Math.floor(world.maxHealth[id])}`)
      if (kind === KIND_FARM) parts.push('Supply +8')
      // Trainable units
      const trainable = kind === KIND_HALL ? ['worker'] : kind === KIND_BARRACKS ? ['melee'] : kind === KIND_ARCHERY ? ['ranged'] : []
      if (trainable.length > 0) parts.push(`Trains ${trainable.map((t) => factionUnitName(world, TEAM_PLAYER, t as UnitType)).join(', ')}`)
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

    const cmd = (label: string, fn: () => void, disabled = false, sub?: string): void => {
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
      btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn() })
      grid.appendChild(btn)
    }

    if (isUnit) {
      if (kind === KIND_WORKER && opts?.buildOpen && cb.onToggleBuild) {
        // Build sub-menu: the build options replace the command row inside
        // the same dashboard space (never a second stacked panel).
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
            // No expander wired: list build options inline (legacy shape).
            for (const btype of PLAYER_BUILDABLE) {
              if (btype === 'farm' && world.factionOfTeam[TEAM_PLAYER] === 'undead') continue
              const bdef = BUILDINGS[btype]
              const afford = canAfford(world, TEAM_PLAYER, btype)
              cmd(BUILD_BUTTON_LABELS[btype] ?? bdef.name, () => cb.onBuildType(btype), !afford, `${bdef.cost.gold}g ${bdef.cost.wood}w`)
            }
          }
        } else {
          cmd('Patrol', () => cb.onMode('patrol'))
          cmd('Hold', () => cb.onHold())
        }
      }
    } else if (isBuilding) {
      // Train buttons
      const trainable: UnitType[] =
        kind === KIND_HALL ? ['worker'] : kind === KIND_BARRACKS ? ['melee'] : kind === KIND_ARCHERY ? ['ranged'] : []
      for (const utype of trainable) {
        const udef = getUnits()[utype]
        const afford =
          world.gold[TEAM_PLAYER] >= udef.cost.gold &&
          world.wood[TEAM_PLAYER] >= udef.cost.wood
        cmd(factionUnitName(world, TEAM_PLAYER, utype), () => cb.onTrain(utype), !afford, `${udef.cost.gold}g ${udef.cost.wood}w`)
      }
      // Upgrade buttons
      if (kind === KIND_BARRACKS) {
        const dmgLvl = world.meleeDmgLvl[TEAM_PLAYER]
        const hpLvl = world.meleeHpLvl[TEAM_PLAYER]
        if (dmgLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Weapon +${dmgLvl + 1}`, () => cb.onResearch('meleeDmg'), !afford, '100g 50w')
        }
        if (hpLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Armor +${hpLvl + 1}`, () => cb.onResearch('meleeHp'), !afford, '100g 50w')
        }
      }
      if (kind === KIND_ARCHERY) {
        const dmgLvl = world.rangedDmgLvl[TEAM_PLAYER]
        if (dmgLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Ranged +${dmgLvl + 1}`, () => cb.onResearch('rangedDmg'), !afford, '100g 50w')
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
        )
      }
      // Orc in-place upgrading: reforge the War-Hall / Foundry through 3 tiers.
      if ((kind === KIND_HALL || kind === KIND_BARRACKS) && world.factionOfTeam[TEAM_PLAYER] === 'orc') {
        const tier = world.tier[id]
        if (tier < 3) {
          const costs = [{ gold: 0, wood: 0 }, { gold: 150, wood: 100 }, { gold: 300, wood: 200 }]
          const cost = costs[tier]
          const afford = world.gold[TEAM_PLAYER] >= cost.gold && world.wood[TEAM_PLAYER] >= cost.wood
          const upgrading = world.upgradeLeft[id] > 0
          const label = upgrading
            ? `Upgrading…`
            : `⬆ ${ORC_TIER_NAMES[tier]}`
          cmd(label, () => cb.onUpgrade(), !afford || upgrading, upgrading ? undefined : `${cost.gold}g ${cost.wood}w`)
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
          const ready = charge >= 50 && !rallying
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
  const cmd: CmdFn = (label, fn, disabled = false, sub) => {
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
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn() })
    grid.appendChild(btn)
  }

  if (allWorkers && opts?.buildOpen && cb.onToggleBuild) {
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
