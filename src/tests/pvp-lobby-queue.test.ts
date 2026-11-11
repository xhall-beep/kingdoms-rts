/**
 * PvP lobby Quick Match socket-lifecycle tests.
 *
 * Background: the match-found path in PvPLobby nulled the matchmaker
 * queue socket without closing it, orphaning an open connection (the
 * server keeps counting the player as queued) while leaveQueue and
 * disconnect both closed theirs. These tests drive the real PvPLobby
 * class with fake DOM/WebSocket/localStorage (installed, then restored,
 * following the canvas-sizing precedent) and pin the close on all
 * three teardown paths.
 */
import { PvPLobby } from '../ui/pvp-lobby.ts'
import { suite, test, assert } from './harness.ts'

class FakeEl {
  hidden = false
  textContent = ''
  value = ''
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  innerHTML = ''
  children: FakeEl[] = []
  private listeners: Record<string, Array<() => void>> = {}
  private qmap = new Map<string, FakeEl>()
  id: string
  constructor(id = '') {
    this.id = id
  }
  addEventListener(ev: string, fn: () => void): void {
    ;(this.listeners[ev] ??= []).push(fn)
  }
  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn()
  }
  appendChild(c: FakeEl): void {
    this.children.push(c)
  }
  querySelector(sel: string): FakeEl {
    const key = sel.replace(/^#/, '')
    let el = this.qmap.get(key)
    if (!el) {
      el = new FakeEl(key)
      this.qmap.set(key, el)
    }
    return el
  }
  querySelectorAll(): FakeEl[] {
    return []
  }
}

class FakeSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = 1
  closed = false
  sent: string[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(s: string): void {
    this.sent.push(s)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeSocket.CLOSED
  }
}

suite('pvp-lobby queue socket')

const g = globalThis as Record<string, unknown>
const prevDocument = g['document']
const prevWebSocket = g['WebSocket']
const prevLocalStorage = g['localStorage']
const store = new Map<string, string>()
g['document'] = { createElement: () => new FakeEl() }
g['WebSocket'] = FakeSocket
g['localStorage'] = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v)
  },
  removeItem: (k: string) => {
    store.delete(k)
  },
}

function setupLobby(): { lobby: PvPLobby; root: FakeEl } {
  FakeSocket.instances.length = 0
  store.clear()
  const parent = new FakeEl('parent')
  const lobby = new PvPLobby()
  lobby.mount(parent as unknown as HTMLElement, {
    onMatchStart: () => undefined,
    onError: (m) => {
      throw new Error('unexpected lobby error: ' + m)
    },
  })
  lobby.show()
  return { lobby, root: parent.children[0] as FakeEl }
}

function joinQueue(root: FakeEl): FakeSocket {
  root.querySelector('#pvp-quick').click()
  const s = FakeSocket.instances[0]
  assert(!!s, 'queue socket must be created by Quick Match')
  assert(s.url.includes('/api/queue/ws'), `first socket must be the queue socket, got ${s.url}`)
  return s
}

function sendMatched(queue: FakeSocket): void {
  queue.onmessage?.({
    data: JSON.stringify({
      kind: 'matched',
      code: 'ABCDEF',
      slot: 0,
      opponent: { playerId: 'opp1', name: 'Foe' },
      matchId: 'm1',
      secret: 's1',
      yourRating: 1200,
    }),
  })
}

test('match-found closes the queue socket and shows the interstitial before joining', () => {
  const { lobby, root } = setupLobby()
  const queue = joinQueue(root)
  sendMatched(queue)
  assert(queue.closed, 'queue socket must be closed on match, not merely nulled')
  assert(FakeSocket.instances.length === 1, 'room socket must NOT be created until the countdown enters')
  assert(!root.querySelector('#pvp-match-found').hidden, 'match-found interstitial must show on match')
  assert(
    root.querySelector('#pvp-found-opponent').textContent === 'vs Foe',
    `interstitial must name the opponent, got ${root.querySelector('#pvp-found-opponent').textContent}`,
  )
  assert(
    root.querySelector('#pvp-found-rating').textContent === 'Your rating: 1200',
    `interstitial must show the rating, got ${root.querySelector('#pvp-found-rating').textContent}`,
  )
  assert(
    root.querySelector('#pvp-found-countdown').textContent === 'Entering match in 3…',
    `interstitial must count down from 3, got ${root.querySelector('#pvp-found-countdown').textContent}`,
  )
  assert(root.querySelector('#pvp-close-row').hidden, 'Close must hide while the match-found countdown runs')
  assert(root.querySelector('#pvp-queue-display').hidden, 'queue display must hide on match')
  lobby.enterMatchedRoom()
  assert(FakeSocket.instances.length >= 2, 'room socket must be created after entering the match')
  assert(
    FakeSocket.instances[1].url.includes('/api/room/ABCDEF/ws'),
    `room socket URL wrong: ${FakeSocket.instances[1].url}`,
  )
  assert(root.querySelector('#pvp-match-found').hidden, 'interstitial must hide once the room join starts')
  assert(!root.querySelector('#pvp-close-row').hidden, 'Close must come back once the room join starts')
})

test('enterMatchedRoom with no pending match joins nothing', () => {
  const { lobby } = setupLobby()
  lobby.enterMatchedRoom()
  assert(FakeSocket.instances.length === 0, 'no socket must be created without a matchmaker pairing')
})

test('disconnect during match-found cancels the pending room join', () => {
  const { lobby, root } = setupLobby()
  const queue = joinQueue(root)
  sendMatched(queue)
  lobby.disconnect()
  assert(root.querySelector('#pvp-match-found').hidden, 'interstitial must clear on disconnect')
  lobby.enterMatchedRoom()
  assert(FakeSocket.instances.length === 1, 'cancelled match must not join the room afterwards')
})

test('cancel closes the queue socket', () => {
  const { root } = setupLobby()
  const queue = joinQueue(root)
  root.querySelector('#pvp-cancel').click()
  assert(queue.closed, 'queue socket must be closed on cancel')
  assert(queue.sent.some((s) => s.includes('"leave"')), 'cancel must send a leave frame')
  assert(root.querySelector('#pvp-queue-display').hidden, 'queue display must hide on cancel')
})

// Restore globals: this file is imported last, after every other suite
// has run, so restoring here cannot disturb them.
if (prevDocument === undefined) delete g['document']
else g['document'] = prevDocument
if (prevWebSocket === undefined) delete g['WebSocket']
else g['WebSocket'] = prevWebSocket
if (prevLocalStorage === undefined) delete g['localStorage']
else g['localStorage'] = prevLocalStorage
