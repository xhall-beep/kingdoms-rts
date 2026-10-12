/**
 * Profile module tests — default creation, save/load, corrupt/mismatch
 * recovery, name sanitisation, and win/loss recording.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  type Profile,
  STORAGE_KEY,
  PROFILE_VERSION,
  createDefaultProfile,
  sanitizeKingdomName,
  loadProfile,
  saveProfile,
  clearProfile,
  recordMatchResult,
  unlockBuilding,
  setBuildingLevel,
  unlockFaction,
  setUnitLevel,
  setHeroLevel,
  setTechLevel,
  buildProgressionSnapshot,
} from '../profile/profile.ts'

// ---- localStorage stub (tests run in Node, which has no localStorage) ----

interface Store {
  [key: string]: string
}

let store: Store = {}

function installLocalStorageStub(): void {
  store = {}
  const ls = {
    getItem(key: string): string | null {
      return store[key] ?? null
    },
    setItem(key: string, value: string): void {
      store[key] = value
    },
    removeItem(key: string): void {
      delete store[key]
    },
    clear(): void {
      store = {}
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  })
}

function restoreLocalStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage
}

suite('profile: default creation')

test('createDefaultProfile has correct shape and version', () => {
  const p = createDefaultProfile('Test Kingdom')
  assertEqual(p.version, PROFILE_VERSION, 'version is 1')
  assertEqual(p.kingdomName, 'Test Kingdom', 'name stored')
  assertEqual(p.campaignProgress.completedMissions.length, 0, 'no completed missions')
  assertEqual(p.campaignProgress.currentMission, null, 'no current mission')
  assert(p.unlockedFactions.includes('human'), 'human unlocked by default')
  assert(p.unlockedBuildings.includes('hall'), 'hall unlocked by default')
  assertEqual(Object.keys(p.stats.perMode).length, 0, 'empty per-mode stats')
  assertEqual(p.ratings.pvpElo, undefined, 'no Elo by default')
})

test('createDefaultProfile uses default name when empty', () => {
  const p = createDefaultProfile('')
  assertEqual(p.kingdomName, 'My Kingdom', 'falls back to default name')
})

test('createdAt is a valid ISO string', () => {
  const p = createDefaultProfile('X')
  const d = new Date(p.createdAt)
  assert(!isNaN(d.getTime()), 'createdAt is a valid date')
  assert(p.createdAt.includes('T'), 'ISO format')
})

suite('profile: name sanitisation')

test('trims whitespace', () => {
  assertEqual(sanitizeKingdomName('  Spaced  '), 'Spaced', 'trims')
})

test('caps at 24 characters', () => {
  const long = 'A'.repeat(30)
  assertEqual(sanitizeKingdomName(long).length, 24, 'capped to 24')
})

test('falls back when empty after trim', () => {
  assertEqual(sanitizeKingdomName('   '), 'My Kingdom', 'whitespace-only → default')
})

test('falls back when cancelled (empty string)', () => {
  assertEqual(sanitizeKingdomName(''), 'My Kingdom', 'empty → default')
})

test('preserves names within limits', () => {
  assertEqual(sanitizeKingdomName('Elf Kingdom'), 'Elf Kingdom', 'normal name kept')
})

suite('profile: save / load round-trip')

test('save then load returns identical profile', () => {
  installLocalStorageStub()
  const p = createDefaultProfile('Riverside')
  const ok = saveProfile(p)
  assert(ok, 'save succeeds')
  const loaded = loadProfile()
  assertEqual(loaded.kingdomName, 'Riverside', 'name preserved')
  assertEqual(loaded.version, PROFILE_VERSION, 'version preserved')
  assertEqual(loaded.createdAt, p.createdAt, 'createdAt preserved')
  assertEqual(
    loaded.campaignProgress.completedMissions.length,
    p.campaignProgress.completedMissions.length,
    'campaign progress preserved',
  )
  restoreLocalStorage()
})

test('clearProfile removes the stored profile', () => {
  installLocalStorageStub()
  saveProfile(createDefaultProfile('Gone'))
  clearProfile()
  const loaded = loadProfile()
  assertEqual(loaded.kingdomName, 'My Kingdom', 'cleared → default')
  restoreLocalStorage()
})

suite('profile: corrupt / missing / version-mismatch recovery')

test('loadProfile returns default when no profile exists', () => {
  installLocalStorageStub()
  const p = loadProfile()
  assertEqual(p.kingdomName, 'My Kingdom', 'missing → default')
  assertEqual(p.version, PROFILE_VERSION, 'correct version')
  restoreLocalStorage()
})

test('loadProfile returns default on corrupt JSON', () => {
  installLocalStorageStub()
  store[STORAGE_KEY] = '{not valid json'
  const p = loadProfile()
  assertEqual(p.kingdomName, 'My Kingdom', 'corrupt → default')
  assert(!Array.isArray((p as unknown as { garbage: unknown }).garbage), 'no leaked fields')
  restoreLocalStorage()
})

test('loadProfile returns default on version mismatch', () => {
  installLocalStorageStub()
  const oldProfile: Profile = {
    ...createDefaultProfile('Old'),
    version: 999 as 2,
  }
  store[STORAGE_KEY] = JSON.stringify(oldProfile)
  const p = loadProfile()
  assertEqual(p.kingdomName, 'My Kingdom', 'version mismatch → default (not old name)')
  assertEqual(p.version, PROFILE_VERSION, 'correct version restored')
  restoreLocalStorage()
})

test('loadProfile returns default on wrong shape', () => {
  installLocalStorageStub()
  store[STORAGE_KEY] = JSON.stringify({ version: 1, wrong: true })
  const p = loadProfile()
  // Should not crash — may return partial data, but kingdomName must exist.
  assert(typeof p.kingdomName === 'string', 'kingdomName is a string')
  restoreLocalStorage()
})

test('saveProfile returns false when localStorage is unavailable', () => {
  // No stub installed — localStorage may not exist in this context.
  // Simulate by making setItem throw.
  const throwingLs = {
    getItem(): string | null { return null },
    setItem(): void { throw new Error('quota') },
    removeItem(): void {},
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: throwingLs,
    writable: true,
    configurable: true,
  })
  const ok = saveProfile(createDefaultProfile('Fail'))
  assert(!ok, 'save returns false on storage error')
  restoreLocalStorage()
})

suite('profile: win / loss recording')

test('recordMatchResult increments wins', () => {
  const p = createDefaultProfile('Wins')
  const updated = recordMatchResult(p, 'skirmish', true)
  assertEqual(updated.stats.perMode['skirmish'].wins, 1, 'one win')
  assertEqual(updated.stats.perMode['skirmish'].losses, 0, 'zero losses')
})

test('recordMatchResult increments losses', () => {
  const p = createDefaultProfile('Losses')
  const updated = recordMatchResult(p, 'pvp', false)
  assertEqual(updated.stats.perMode['pvp'].wins, 0, 'zero wins')
  assertEqual(updated.stats.perMode['pvp'].losses, 1, 'one loss')
})

test('multiple results accumulate per mode', () => {
  let p = createDefaultProfile('Accum')
  p = recordMatchResult(p, 'tower-defense', true)
  p = recordMatchResult(p, 'tower-defense', true)
  p = recordMatchResult(p, 'tower-defense', false)
  assertEqual(p.stats.perMode['tower-defense'].wins, 2, 'two wins')
  assertEqual(p.stats.perMode['tower-defense'].losses, 1, 'one loss')
})

test('different modes are tracked separately', () => {
  let p = createDefaultProfile('Multi')
  p = recordMatchResult(p, 'skirmish', true)
  p = recordMatchResult(p, 'pvp', false)
  p = recordMatchResult(p, 'campaign', true)
  assertEqual(p.stats.perMode['skirmish'].wins, 1, 'skirmish win')
  assertEqual(p.stats.perMode['pvp'].losses, 1, 'pvp loss')
  assertEqual(p.stats.perMode['campaign'].wins, 1, 'campaign win')
  assertEqual(Object.keys(p.stats.perMode).length, 3, 'three modes tracked')
})

test('recordMatchResult does not mutate the original profile', () => {
  const p = createDefaultProfile('Immutable')
  const _updated = recordMatchResult(p, 'skirmish', true)
  assertEqual(Object.keys(p.stats.perMode).length, 0, 'original unchanged')
  void _updated
})

suite('profile v2: progression levels')

test('default profile seeds building levels and unit roster', () => {
  installLocalStorageStub()
  const p = createDefaultProfile('Levels')
  assertEqual(p.version, 2, 'version 2')
  assertEqual(p.buildingLevels['hall'], 1, 'hall level 1')
  assertEqual(p.buildingLevels['farm'], 1, 'farm level 1')
  assert(p.unitRoster['worker'].unlocked, 'worker unlocked')
  assertEqual(p.unitRoster['melee'].level, 1, 'melee level 1')
  assertEqual(Object.keys(p.heroes).length, 0, 'no heroes yet')
  assertEqual(Object.keys(p.techLevels).length, 0, 'no tech yet')
})

test('v1 profile migrates to v2 with derived level maps', () => {
  installLocalStorageStub()
  const v1 = {
    version: 1,
    kingdomName: 'Old Kingdom',
    createdAt: '2026-01-01T00:00:00.000Z',
    campaignProgress: { completedMissions: [], currentMission: null },
    unlockedFactions: ['human', 'elf'],
    unlockedBuildings: ['hall', 'farm', 'barracks'],
    stats: { perMode: {} },
    ratings: {},
  }
  store[STORAGE_KEY] = JSON.stringify(v1)
  const p = loadProfile()
  assertEqual(p.version, 2, 'migrated to v2')
  assertEqual(p.kingdomName, 'Old Kingdom', 'name preserved')
  assertEqual(p.buildingLevels['barracks'], 1, 'barracks derived at 1')
  assert(p.unitRoster['ranged'].unlocked, 'ranged unlocked from factions')
  assert(p.unlockedFactions.includes('elf'), 'elf preserved')
})

test('unlock and level helpers', () => {
  installLocalStorageStub()
  let p = createDefaultProfile('Helper')
  p = unlockBuilding(p, 'barracks')
  assert(p.unlockedBuildings.includes('barracks'), 'barracks unlocked')
  assertEqual(p.buildingLevels['barracks'], 1, 'starts at 1')
  p = setBuildingLevel(p, 'barracks', 3)
  assertEqual(p.buildingLevels['barracks'], 3, 'level set to 3')
  p = unlockFaction(p, 'orc')
  assert(p.unlockedFactions.includes('orc'), 'orc unlocked')
  p = setUnitLevel(p, 'melee', 2)
  assertEqual(p.unitRoster['melee'].level, 2, 'melee level 2')
  p = setTechLevel(p, 'siege', 2)
  assertEqual(p.techLevels['siege'], 2, 'tech set')
  p = setTechLevel(p, 'siege', 0)
  assert(!('siege' in p.techLevels), 'tech removed at 0')
  p = setHeroLevel(p, 'warchief', 5)
  assertEqual(p.heroes['warchief'], 5, 'hero set')
})

test('buildProgressionSnapshot matches server shape', () => {
  installLocalStorageStub()
  let p = createDefaultProfile('Snap')
  p = setBuildingLevel(p, 'hall', 3)
  p = setTechLevel(p, 'masonry', 2)
  const snap = buildProgressionSnapshot(p, { melee: 10, worker: 5 })
  assertEqual(snap.buildings['hall'], 3, 'hall level 3 in snapshot')
  assert(snap.units['worker'].unlocked, 'worker in snapshot')
  assertEqual(snap.tech['masonry'], 2, 'tech in snapshot')
  assertEqual(snap.army['melee'], 10, 'army passes through')
  assertEqual(snap.army['worker'], 5, 'army worker count')
  // JSON-safe for btoa transport
  const encoded = btoa(JSON.stringify(snap))
  const decoded = JSON.parse(atob(encoded))
  assertEqual(decoded.buildings['hall'], 3, 'round-trips through btoa')
})

test('snapshot of fresh profile is non-empty (power > 0)', () => {
  installLocalStorageStub()
  const snap = buildProgressionSnapshot(createDefaultProfile('Fresh'))
  assert(Object.keys(snap.buildings).length > 0, 'buildings non-empty')
  assert(Object.keys(snap.units).length > 0, 'units non-empty')
})