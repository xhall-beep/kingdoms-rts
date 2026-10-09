/**
 * Minimal headless test harness — zero dependencies.
 * Run with: npx tsc (typecheck) then node on compiled output,
 * or via the `npm test` script.
 */

export interface TestResult {
  name: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []
let currentSuite = ''

export function suite(name: string): void {
  currentSuite = name
}

export function test(name: string, fn: () => void): void {
  const fullName = currentSuite ? `${currentSuite}: ${name}` : name
  try {
    fn()
    results.push({ name: fullName, passed: true })
  } catch (e) {
    results.push({
      name: fullName,
      passed: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} — expected ${expected}, got ${actual}`)
  }
}

export function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message} — expected ${expected} ± ${tolerance}, got ${actual}`)
  }
}

export function report(): boolean {
  let passed = 0
  let failed = 0
  for (const r of results) {
    if (r.passed) {
      passed += 1
    } else {
      failed += 1
      console.error(`FAIL: ${r.name}`)
      if (r.error) console.error(`  ${r.error}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`)
  return failed === 0
}

export function reset(): void {
  results.length = 0
  currentSuite = ''
}
