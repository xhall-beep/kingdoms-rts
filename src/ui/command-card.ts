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
import { UNITS } from '../data/units.ts'
import type { UnitType } from '../data/units.ts'
import { BUILDINGS } from '../data/buildings.ts'
import { PLAYER_BUILDABLE, canAfford } from '../world/construction.ts'
import { FACTIONS } from '../data/factions.ts'

export interface CommandCardCallbacks {
  onMode(mode: 'move' | 'attack' | 'gather' | 'build' | 'patrol'): void
  onStop(): void
  onHold(): void
  onBuildType(type: string): void
  onTrain(type: string): void
  onResearch(type: string): void
  onSetRally?(): void
}

/** Faction color for portrait background. */
function factionColor(world: World, id: number): string {
  const team = world.team[id] as 0 | 1
  const fid = world.factionOfTeam?.[team] ?? 'human'
  const colors = FACTIONS[fid]?.colors ?? [0x2f6fd6, 0xf5c542, 0xdfe8f5]
  return `#${colors[0].toString(16).padStart(6, '0')}`
}

function unitLabel(kind: number): string {
  if (kind === KIND_WORKER) return 'Worker'
  if (kind === KIND_MELEE) return 'Melee'
  if (kind === KIND_RANGED) return 'Ranged'
  return '?'
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
 */
export function renderCommandCard(
  el: HTMLElement,
  world: World,
  selected: number[],
  cb: CommandCardCallbacks,
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
      ? unitLabel(kind)[0]
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
        ? unitLabel(kind)
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

  // --- Stats grid ---
  const stats = document.createElement('div')
  stats.className = 'cmd-stats'

  const stat = (label: string, value: string): void => {
    const s = document.createElement('div')
    s.className = 'cmd-stat'
    const l = document.createElement('div')
    l.className = 'cmd-stat-label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'cmd-stat-value'
    v.textContent = value
    s.appendChild(l)
    s.appendChild(v)
    stats.appendChild(s)
  }

  if (isUnit) {
    const utype: UnitType =
      kind === KIND_WORKER ? 'worker' : kind === KIND_MELEE ? 'melee' : 'ranged'
    const def = UNITS[utype]
    stat('Damage', String(def.damage))
    stat('Range', String(def.range))
    stat('Sight', String(def.sight))
    stat('Speed', String(def.speed ?? '—'))
    stat('Armor', String((def as { armor?: number }).armor ?? 0))
    stat('Cost', `${def.cost.gold}g ${def.cost.wood}w`)
  } else if (isBuilding) {
    const btype = kind === KIND_HALL ? 'hall' : kind === KIND_BARRACKS ? 'barracks' : kind === KIND_ARCHERY ? 'archery' : 'farm'
    const bdef = BUILDINGS[btype as keyof typeof BUILDINGS]
    if (bdef) {
      stat('HP', `${Math.floor(world.health[id])}/${Math.floor(world.maxHealth[id])}`)
      if (kind === KIND_FARM) stat('Supply', '+8')
      // Trainable units
      const trainable = kind === KIND_HALL ? ['worker'] : kind === KIND_BARRACKS ? ['melee'] : kind === KIND_ARCHERY ? ['ranged'] : []
      if (trainable.length > 0) stat('Trains', trainable.map((t) => t[0].toUpperCase() + t.slice(1)).join(', '))
    }
  } else if (isResource) {
    const res = kind === KIND_TREE ? 'Wood' : 'Gold'
    stat('Type', res)
    stat('Remaining', String(Math.floor(world.amount[id])))
  }
  if (stats.children.length > 0) card.appendChild(stats)

  // --- Command grid (own units/buildings only) ---
  if (isOwn && (isUnit || isBuilding)) {
    const grid = document.createElement('div')
    grid.className = 'cmd-grid'

    const cmd = (label: string, fn: () => void, disabled = false, hotkey?: string): void => {
      const btn = document.createElement('button')
      btn.className = 'cmd-btn'
      btn.disabled = disabled
      const lbl = document.createElement('span')
      lbl.className = 'cmd-btn-label'
      lbl.textContent = label
      btn.appendChild(lbl)
      if (hotkey) {
        const hk = document.createElement('span')
        hk.className = 'cmd-btn-hotkey'
        hk.textContent = hotkey
        btn.appendChild(hk)
      }
      btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn() })
      grid.appendChild(btn)
    }

    if (isUnit) {
      cmd('Move', () => cb.onMode('move'), false, 'M')
      cmd('Attack', () => cb.onMode('attack'), false, 'A')
      cmd('Stop', () => cb.onStop(), false, 'S')
      if (kind === KIND_WORKER) {
        cmd('Gather', () => cb.onMode('gather'), false, 'G')
        // Build options as separate buttons
        for (const btype of PLAYER_BUILDABLE) {
          const bdef = BUILDINGS[btype]
          const afford = canAfford(world, TEAM_PLAYER, btype)
          cmd(
            `${bdef.name} ${bdef.cost.gold}g ${bdef.cost.wood}w`,
            () => cb.onBuildType(btype),
            !afford,
          )
        }
      } else {
        cmd('Patrol', () => cb.onMode('patrol'), false, 'P')
        cmd('Hold', () => cb.onHold(), false, 'H')
      }
    } else if (isBuilding) {
      // Train buttons
      const trainable: UnitType[] =
        kind === KIND_HALL ? ['worker'] : kind === KIND_BARRACKS ? ['melee'] : kind === KIND_ARCHERY ? ['ranged'] : []
      for (const utype of trainable) {
        const udef = UNITS[utype]
        const afford =
          world.gold[TEAM_PLAYER] >= udef.cost.gold &&
          world.wood[TEAM_PLAYER] >= udef.cost.wood
        cmd(`${utype[0].toUpperCase() + utype.slice(1)} ${udef.cost.gold}g`, () => cb.onTrain(utype), !afford)
      }
      // Upgrade buttons
      if (kind === KIND_BARRACKS) {
        const dmgLvl = world.meleeDmgLvl[TEAM_PLAYER]
        const hpLvl = world.meleeHpLvl[TEAM_PLAYER]
        if (dmgLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Weapon +${dmgLvl + 1} 100g`, () => cb.onResearch('meleeDmg'), !afford)
        }
        if (hpLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Armor +${hpLvl + 1} 100g`, () => cb.onResearch('meleeHp'), !afford)
        }
      }
      if (kind === KIND_ARCHERY) {
        const dmgLvl = world.rangedDmgLvl[TEAM_PLAYER]
        if (dmgLvl < 3) {
          const afford = world.gold[TEAM_PLAYER] >= 100 && world.wood[TEAM_PLAYER] >= 50
          cmd(`Ranged +${dmgLvl + 1} 100g`, () => cb.onResearch('rangedDmg'), !afford)
        }
      }
      if (cb.onSetRally) cmd('Rally', () => cb.onSetRally!(), false, 'R')
    }

    if (grid.children.length > 0) card.appendChild(grid)
  }

  el.appendChild(card)
  return true
}
