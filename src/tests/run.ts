/** Test runner entry — imports all suites, prints results, exits non-zero on failure. */
import { report } from './harness.ts'
import './sim.test.ts'
import './input.test.ts'
import './session.test.ts'
import '../net/protocol.test.ts'
import '../net/hash.test.ts'
import '../net/lockstep.test.ts'
import '../net/pvp-session.test.ts'

const ok = report()
const _p = (globalThis as unknown as { process?: { exit(c: number): void } }).process
if (_p) _p.exit(ok ? 0 : 1)
