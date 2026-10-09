/**
 * Performance benchmarks — headless sim speed measurement.
 * Establishes a baseline to catch performance regressions.
 */
import { makeWorld, STEP } from './setup.ts'

export interface PerfResult {
  stepsPerSecond: number
  msPerStep: number
  totalSteps: number
  wallSeconds: number
}

export function benchmark(steps = 60 * 60): PerfResult {
  const world = makeWorld()
  // Warm up.
  for (let i = 0; i < 120; i += 1) world.update(STEP)

  const start = Date.now()
  for (let i = 0; i < steps; i += 1) world.update(STEP)
  const wallMs = Date.now() - start
  const wallSeconds = wallMs / 1000

  return {
    stepsPerSecond: steps / wallSeconds,
    msPerStep: wallMs / steps,
    totalSteps: steps,
    wallSeconds,
  }
}

/** CLI entry. */
const g = globalThis as unknown as { process?: { argv: string[] } }
if (typeof g.process !== 'undefined' && g.process.argv[1]?.includes('perf')) {
  const steps = parseInt(g.process.argv[2] || '3600', 10)
  console.log(`Benchmarking ${steps} steps...`)
  const r = benchmark(steps)
  console.log(`Steps/sec: ${r.stepsPerSecond.toFixed(0)}`)
  console.log(`Ms/step: ${r.msPerStep.toFixed(3)}`)
  console.log(`Wall time: ${r.wallSeconds.toFixed(1)}s for ${r.totalSteps} steps`)
  // 60 steps/sec = real-time. Higher = headroom.
  const realtime = r.stepsPerSecond / 60
  console.log(`Real-time factor: ${realtime.toFixed(1)}x`)
}
