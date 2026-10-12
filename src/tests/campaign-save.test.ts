/**
 * Campaign-save module tests — save/load round-trip, corrupt JSON,
 * version mismatch, wrong-shape recovery, and clear/has helpers.
 */
import { suite, test, assert, assertEqual } from './harness.ts'
import {
  CAMPAIGN_SAVE_KEY,
  CAMPAIGN_SAVE_VERSION,
  saveCampaignSave,
  loadCampaignSave,
  clearCampaignSave,
  hasCampaignSave,
} from '../profile/campaign-save.ts'

// ---- localStorage stub (tests run in Node, which has no localStorage) ----
interface Store {
  [key: string]: string
}
let store: Store = {}
function installLocalStorageStub(): void {
  store = {}
  const ls = {
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
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

suite('campaign-save: round-trip')
test('save then load returns the payload with version and savedAt', () => {
  installLocalStorageStub()
  try {
    saveCampaignSave({ mode: 'campaign', mission: 'mission-1', snapshot: 'opaque-data' })
    const loaded = loadCampaignSave()
    if (loaded === null) throw new Error('load returns non-null')
    assertEqual(loaded.mode, 'campaign', 'mode preserved')
    assertEqual(loaded.mission, 'mission-1', 'mission preserved')
    assertEqual(loaded.snapshot, 'opaque-data', 'snapshot preserved')
    assertEqual(loaded.version, CAMPAIGN_SAVE_VERSION, 'version stamped')
    assert(typeof loaded.savedAt === 'string' && loaded.savedAt.length > 0, 'savedAt stamped')
  } finally {
    restoreLocalStorage()
  }
})

test('hasCampaignSave reflects stored state', () => {
  installLocalStorageStub()
  try {
    assert(!hasCampaignSave(), 'no save initially')
    saveCampaignSave({ mode: 'campaign', mission: null, snapshot: 'x' })
    assert(hasCampaignSave(), 'save detected after write')
    clearCampaignSave()
    assert(!hasCampaignSave(), 'no save after clear')
  } finally {
    restoreLocalStorage()
  }
})

suite('campaign-save: recovery')
test('corrupt JSON returns null', () => {
  installLocalStorageStub()
  try {
    store[CAMPAIGN_SAVE_KEY] = 'not-json{{'
    assert(loadCampaignSave() === null, 'corrupt JSON -> null')
    assert(!hasCampaignSave(), 'hasCampaignSave false on corrupt JSON')
  } finally {
    restoreLocalStorage()
  }
})

test('version mismatch returns null', () => {
  installLocalStorageStub()
  try {
    store[CAMPAIGN_SAVE_KEY] = JSON.stringify({
      version: CAMPAIGN_SAVE_VERSION + 1,
      mode: 'campaign',
      mission: null,
      savedAt: new Date().toISOString(),
      snapshot: 'x',
    })
    assert(loadCampaignSave() === null, 'wrong version -> null')
  } finally {
    restoreLocalStorage()
  }
})

test('wrong shape returns null', () => {
  installLocalStorageStub()
  try {
    store[CAMPAIGN_SAVE_KEY] = JSON.stringify({ version: CAMPAIGN_SAVE_VERSION, nope: true })
    assert(loadCampaignSave() === null, 'wrong shape -> null')
  } finally {
    restoreLocalStorage()
  }
})

test('missing key returns null', () => {
  installLocalStorageStub()
  try {
    assert(loadCampaignSave() === null, 'missing key -> null')
  } finally {
    restoreLocalStorage()
  }
})

test('save overwrites previous save', () => {
  installLocalStorageStub()
  try {
    saveCampaignSave({ mode: 'campaign', mission: 'm1', snapshot: 'first' })
    saveCampaignSave({ mode: 'campaign', mission: 'm2', snapshot: 'second' })
    const loaded = loadCampaignSave()
    if (loaded === null) throw new Error('load returns non-null')
    assertEqual(loaded.mission, 'm2', 'latest mission wins')
    assertEqual(loaded.snapshot, 'second', 'latest snapshot wins')
  } finally {
    restoreLocalStorage()
  }
})
