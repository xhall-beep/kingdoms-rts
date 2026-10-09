/** Test runner entry — imports all suites, prints results, exits non-zero on failure. */
import { report } from './harness.ts'
import './sim.test.ts'
import './input.test.ts'
import './session.test.ts'

const ok = report()
// @ts-expect-error — process is available in node
process.exit(ok ? 0 : 1)
