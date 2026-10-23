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
import { ORC_TIER_NAMES } from '../systems/production.ts'
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

/**
 * Render a command card into `el` for the given selection.
 * Returns true if a card was rendered, false for empty selection.
 *
 * Layout: this renders into the bottom dashboard — one identity row
 * (portrait chip, name, HP bar), one compact stat LINE (no grid), and a
 * single row of unit-specific command buttons. For workers, Build is an
 * expander: `opts.buildOpen` swaps the command row for the build options
 * (plus Back) in the same dashboard space.
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
        for (const btype of PLAYER_BUILDABLE) {
          // Undead raise no farms — Soul-Ash feeds their supply cap.
          if (btype === 'farm' && world.factionOfTeam[TEAM_PLAYER] === 'undead') continue
          const bdef = BUILDINGS[btype]
          const afford = canAfford(world, TEAM_PLAYER, btype)
          cmd(bdef.name, () => cb.onBuildType(btype), !afford, `${bdef.cost.gold}g ${bdef.cost.wood}w`)
        }
        cmd('◀ Back', () => cb.onToggleBuild?.())
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
              cmd(bdef.name, () => cb.onBuildType(btype), !afford, `${bdef.cost.gold}g ${bdef.cost.wood}w`)
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
      if (kind === KIND_HALL && world.factionOfTeam[TEAM_PLAYER] === 'human') {
        const onCooldown = world.matchTime < world.militiaCooldown[TEAM_PLAYER]
        cmd(
          onCooldown ? '🔔 Bell (cd)' : '🔔 Militia Bell',
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
        const labels: Record<number, string> = { 1: '🌪 Gale March', 2: '🩸 Ironblood', 3: '💨 Second Wind' }
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
