/**
 * Combat motion — attack lunge + squash-on-hit are render-only game feel:
 * the striker leans into the blow, the struck body squashes while its
 * hit flash fades. Both read sim state the renderer already sees, keep
 * all state on the renderer, and must never enter the lockstep hash.
 * Pure-envelope tests pin the math; recording-canvas tests pin the
 * renderer wiring (cooldown-reset strike detection, lunge offset toward
 * the target, squash transform on the struck body).
 */
import { KIND_MELEE, STATE_ATTACK } from '../core/World.ts'
import { hashWorldState } from '../net/hash.ts'
import { Renderer } from '../render/renderer.ts'
import {
  LUNGE_DURATION,
  SQUASH_AMOUNT,
  SQUASH_DURATION,
  lungeProgress,
  squashFactors,
  strikeJustFired,
} from '../render/motion.ts'
import { makeWorld, stepWorld } from './setup.ts'
import { suite, test, assert, assertClose, assertEqual } from './harness.ts'

// ---------------------------------------------------------------------------
// Pure envelopes
// ---------------------------------------------------------------------------

suite('combat motion: pure envelopes')

test('strike detection is the cooldown jumping up between renders', () => {
  assertEqual(strikeJustFired(undefined, 0.8), false, 'no previous reading is never a strike')
  assertEqual(strikeJustFired(0.8, 0.8), false, 'a flat cooldown is not a strike')
  assertEqual(strikeJustFired(0.8, 0.2), false, 'a counting-down cooldown is not a strike')
  assertEqual(strikeJustFired(0.0, 0.8), true, 'reset from zero to full is a strike')
  assertEqual(strikeJustFired(0.3, 0.8), true, 'reset mid-countdown is a strike')
})

test('lunge envelope rests at both ends and peaks mid-swing', () => {
  assertEqual(lungeProgress(0), 0, 'age zero is rest')
  assertEqual(lungeProgress(LUNGE_DURATION), 0, 'age at duration is rest')
  assertEqual(lungeProgress(LUNGE_DURATION * 2), 0, 'past duration is rest')
  assertEqual(lungeProgress(-0.01), 0, 'negative age is rest')
  assertClose(lungeProgress(LUNGE_DURATION / 2), 1, 0.001, 'mid-swing peaks at 1')
  const quarter = lungeProgress(LUNGE_DURATION / 4)
  assert(quarter > 0 && quarter < 1, `quarter-swing is partial, got ${quarter}`)
})

test('squash is wide and short at impact, easing back to identity', () => {
  assertEqual(squashFactors(undefined).sx, 1, 'no flash is unscaled')
  assertEqual(squashFactors(SQUASH_DURATION).sx, 1, 'expired flash is unscaled')
  const atHit = squashFactors(0)
  assertClose(atHit.sx, 1 + SQUASH_AMOUNT, 0.001, 'impact widens the body')
  assertClose(atHit.sy, 1 - SQUASH_AMOUNT, 0.001, 'impact shortens the body')
  const late = squashFactors(SQUASH_DURATION * 0.9)
  assert(late.sx > 1 && late.sx < atHit.sx, 'squash eases back toward identity')
  assert(late.sy < 1 && late.sy > atHit.sy, 'squash eases back toward identity')
})

// ---------------------------------------------------------------------------
// Renderer wiring — recording canvas
// ---------------------------------------------------------------------------

interface RecordedArc {
  x: number
  y: number
  rx: number
  ry: number
}

/** Canvas 2d stand-in that records arcs through the live transform. */
class RecordingCtx {
  arcs: RecordedArc[] = []
  fillStyle = ''
  strokeStyle = ''
  font = ''
  textAlign = ''
  textBaseline = ''
  globalAlpha = 1
  lineWidth = 1
  private stack: { tx: number; ty: number; sx: number; sy: number }[] = [
    { tx: 0, ty: 0, sx: 1, sy: 1 },
  ]

  private cur(): { tx: number; ty: number; sx: number; sy: number } {
    return this.stack[this.stack.length - 1]
  }

  save(): void {
    this.stack.push({ ...this.cur() })
  }

  restore(): void {
    if (this.stack.length > 1) this.stack.pop()
  }

  translate(dx: number, dy: number): void {
    const c = this.cur()
    c.tx += c.sx * dx
    c.ty += c.sy * dy
  }

  scale(sx: number, sy: number): void {
    const c = this.cur()
    c.sx *= sx
    c.sy *= sy
  }

  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number): void {
    const cur = this.cur()
    cur.sx = a
    cur.sy = d
    cur.tx = e
    cur.ty = f
  }

  beginPath(): void {}
  closePath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  fill(): void {}
  stroke(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  drawImage(): void {}
  fillText(): void {}
  strokeText(): void {}
  setLineDash(): void {}
  ellipse(): void {}

  arc(x: number, y: number, r: number): void {
    const c = this.cur()
    this.arcs.push({ x: c.sx * x + c.tx, y: c.sy * y + c.ty, rx: r * c.sx, ry: r * c.sy })
  }
}

function stubDocument(): () => void {
  const prev = (globalThis as Record<string, unknown>)['document']
  ;(globalThis as Record<string, unknown>)['document'] = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
      const ctx = new RecordingCtx()
      return { width: 0, height: 0, getContext: () => ctx }
    },
  }
  return () => {
    if (prev === undefined) delete (globalThis as Record<string, unknown>)['document']
    else (globalThis as Record<string, unknown>)['document'] = prev
  }
}

function makeDuel(): {
  world: ReturnType<typeof makeWorld>
  ctx: RecordingCtx
  renderer: Renderer
  attacker: number
  victim: number
} {
  const world = makeWorld()
  const a = world.spawnUnit('melee', 0, 0, 0)
  const b = world.spawnUnit('melee', 1, 1.2, 0)
  for (const u of [a, b]) {
    world.health[u.id] = 100000
    world.maxHealth[u.id] = 100000
    world.sight[u.id] = 50
  }
  const ctx = new RecordingCtx()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement)
  renderer.resize(412, 800)
  renderer.centerOn(0, 0, 10)
  return { world, ctx, renderer, attacker: a.id, victim: b.id }
}

/**
 * Max arc centre-x in a narrow horizontal window around screen y = 400,
 * restricted to unit-body radii (disc 5, ring 3.5, squashed up to ~5.9):
 * trees (13), gold (20) and buildings (25+) can never pollute it.
 */
function maxBodyArcX(ctx: RecordingCtx, x0: number, x1: number): number {
  let max = -Infinity
  for (const arc of ctx.arcs) {
    if (
      Math.abs(arc.y - 400) < 0.5 &&
      arc.x >= x0 &&
      arc.x <= x1 &&
      arc.rx >= 3.4 &&
      arc.rx <= 6.1
    ) {
      max = Math.max(max, arc.x)
    }
  }
  return max
}

/** A squashed unit-body arc in the window: rx visibly wider than ry. */
function hasSquashedBodyArc(ctx: RecordingCtx, x0: number, x1: number): boolean {
  return ctx.arcs.some(
    (arc) =>
      Math.abs(arc.y - 400) < 0.5 &&
      arc.x >= x0 &&
      arc.x <= x1 &&
      arc.rx >= 3.4 &&
      arc.rx <= 6.1 &&
      arc.rx - arc.ry > 0.2,
  )
}

suite('combat motion: renderer wiring')

test('melee strike lunges the striker toward its target on the next render', () => {
  const restore = stubDocument()
  try {
    const { world, ctx, renderer } = makeDuel()
    // Baseline render: no strikes yet, bodies at base positions.
    renderer.render(world, 0, 1 / 60)
    const before = maxBodyArcX(ctx, 196, 216)
    assert(before > 200 && before <= 207, `attacker arcs near base x, got ${before}`)
    // Two steps: both melee units trade blows (combat-feel precedent).
    stepWorld(world, 2)
    // Strike render: cooldown reset detected, lunge recorded at age 0.
    renderer.render(world, 0, 1 / 60)
    ctx.arcs.length = 0
    // Next render at mid-swing: the lunge peaks toward the victim (+x).
    renderer.render(world, 0, LUNGE_DURATION / 2)
    const after = maxBodyArcX(ctx, 196, 220)
    assert(
      after - before > 1,
      `lunge must shift the attacker body toward the victim: ${before} -> ${after}`,
    )
    assert(after > 206, `lunged body sits past the base position, got ${after}`)
  } finally {
    restore()
  }
})

test('struck body squashes on the strike render, unscaled before any strike', () => {
  const restore = stubDocument()
  try {
    const { world, ctx, renderer } = makeDuel()
    renderer.render(world, 0, 1 / 60)
    assert(!hasSquashedBodyArc(ctx, 212, 224), 'no squash before any strike lands')
    stepWorld(world, 2)
    ctx.arcs.length = 0
    renderer.render(world, 0, 1 / 60)
    assert(
      hasSquashedBodyArc(ctx, 212, 224),
      'victim body arcs must show rx > ry on the strike render',
    )
  } finally {
    restore()
  }
})

test('rendering combat motion never touches the lockstep hash', () => {
  const restore = stubDocument()
  try {
    const { world, renderer } = makeDuel()
    stepWorld(world, 2)
    const before = hashWorldState(world)
    renderer.render(world, 0, 1 / 60)
    renderer.render(world, 0, LUNGE_DURATION / 2)
    assertEqual(hashWorldState(world), before, 'renders must not change hashed state')
    // Sanity: the duel really is a fight — a melee kind is present.
    assert(world.kind.some((k) => k === KIND_MELEE), 'duel contains melee units')
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// Militia lunge — mustered peasants fight as melee (combat.ts) but keep
// KIND_WORKER, so the renderer's strike detection must include them.
// Bell mustering itself is pinned by militia.test.ts; here the muster
// state is set directly so the test does not depend on a seeded hall.
// ---------------------------------------------------------------------------

suite('combat motion: militia lunge')

function makeMilitiaDuel(mustered: boolean): {
  world: ReturnType<typeof makeWorld>
  ctx: RecordingCtx
  renderer: Renderer
  worker: number
  enemy: number
} {
  const world = makeWorld()
  const worker = world.spawnUnit('worker', 0, 0, 0)
  const enemy = world.spawnUnit('melee', 1, 1.2, 0)
  for (const u of [worker, enemy]) {
    world.health[u.id] = 100000
    world.maxHealth[u.id] = 100000
    world.sight[u.id] = 50
  }
  if (mustered) world.militiaUntil[worker.id] = world.matchTime + 25
  // Force the worker into combat range (militia.test.ts precedent).
  world.state[worker.id] = STATE_ATTACK
  world.targetId[worker.id] = enemy.id
  world.moving[worker.id] = 0
  world.cooldown[worker.id] = 0
  const ctx = new RecordingCtx()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement)
  renderer.resize(412, 800)
  renderer.centerOn(0, 0, 10)
  return { world, ctx, renderer, worker: worker.id, enemy: enemy.id }
}

test('mustered militia peasant lunges toward its target on the next render', () => {
  const restore = stubDocument()
  try {
    const { world, ctx, renderer, worker } = makeMilitiaDuel(true)
    assert(world.isMilitia(worker), 'worker is mustered militia in this duel')
    renderer.render(world, 0, 1 / 60)
    const before = maxBodyArcX(ctx, 196, 216)
    assert(before > 200 && before <= 207, `worker arcs near base x, got ${before}`)
    stepWorld(world, 2)
    renderer.render(world, 0, 1 / 60)
    ctx.arcs.length = 0
    renderer.render(world, 0, LUNGE_DURATION / 2)
    const after = maxBodyArcX(ctx, 196, 220)
    assert(
      after - before > 1,
      `militia lunge must shift the worker body toward the enemy: ${before} -> ${after}`,
    )
    assert(after > 206, `lunged worker body sits past the base position, got ${after}`)
  } finally {
    restore()
  }
})

test('unmustered worker never lunges (it cannot strike)', () => {
  const restore = stubDocument()
  try {
    const { world, ctx, renderer, worker } = makeMilitiaDuel(false)
    assert(!world.isMilitia(worker), 'worker is an ordinary peasant in this duel')
    renderer.render(world, 0, 1 / 60)
    const before = maxBodyArcX(ctx, 196, 210)
    assert(before > 200 && before <= 207, `worker arcs near base x, got ${before}`)
    stepWorld(world, 2)
    renderer.render(world, 0, 1 / 60)
    ctx.arcs.length = 0
    renderer.render(world, 0, LUNGE_DURATION / 2)
    const after = maxBodyArcX(ctx, 196, 210)
    assert(
      after - before <= 0.5,
      `ordinary worker must not lunge: ${before} -> ${after}`,
    )
  } finally {
    restore()
  }
})
