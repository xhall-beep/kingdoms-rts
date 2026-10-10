# Kingdoms RTS — Lockstep Netcode (Phase 1)

Deterministic lockstep multiplayer foundation. Two (or N) peers, each simulating
the full game locally; **only player inputs cross the wire**. Zero server required
for Phase 1 — peers connect through a `ReliableLink` over any `UnreliableTransport`
(loopback or simulated adverse network).

## Files

| File | Purpose |
|---|---|
| `protocol.ts` | Wire protocol: versioned binary codec (varint + f32), 8 message kinds, all 8 command types. `messageSize` is exact (single allocation). |
| `hash.ts` | FNV-1a 64-bit deterministic state hash over the full sim state. NaN-canonicalized. |
| `snapshot.ts` | Bit-exact world snapshot → bytes → world. Powers desync resync. |
| `transport.ts` | `UnreliableTransport` interface, `LoopbackTransport`, `SimulatedNetwork` (seeded latency/jitter/loss/reorder — reproducible adversity), `ReliableLink` (seq + cumulative ack + retransmit, in-order delivery). |
| `turn.ts` | `LockstepPeer`: turn manager. 4 turns/sec, 2-turn input delay (adaptive later), hash exchange every 40 turns, stall detection. |
| `apply.ts` | `applyCommand(world, cmd)` — deterministic command application (team derived from worker, unlike the replay path which hardcodes team 0). |
| `driver.ts` | `ScriptedDriver`: deterministic scripted player for tests (gather → farm → barracks → army → attack). |
| `session.ts` | `createLockstepSession` (steppable) + `runLockstepMatch` (headless full match). Auto-resync on desync. |
| `demo.ts` | Visual demo: two renderers side-by-side, live hash comparison, network/speed controls, desync injection. |

## Protocol

- **Turns:** 4/sec, 15 sim-steps each. Inputs scheduled `inputDelay` (2) turns ahead.
- **Execution order:** player 0's commands (queued order), then player 1's. Command `step` is re-stamped as `turn * STEPS_PER_TURN` (not transmitted).
- **Hashes:** every 40 turns (10 sim-seconds). Mismatch → desync → peer 1 adopts peer 0's snapshot + turn (deterministic rule), re-verified at the next exchange.
- **Bandwidth:** ~1.25 KB/min/player (measured, 5-min scripted match).

## Determinism contract

The sim must never consume `Math.random()`, `Date.now()`, or any nondeterminism
in `world.update()`. Verified: none present. Two hidden states were found and
fixed during Phase 1:
- `FogGrid.visibleNow` (pending demotions) — added to hash + snapshot.
- `VictorySystemImpl.timer` — added to hash + snapshot.

If you add mutable state to a system or the world, add it to `hash.ts` and
`snapshot.ts` or lockstep will diverge after resync.

## Tests (37)

- `protocol.test.ts` — round-trips, 500-command fuzz, size budgets, version/tag rejection.
- `hash.test.ts` — stability, sensitivity, 3600-step divergence-free, snapshot bit-exactness.
- `lockstep.test.ts` — 5-min and 10-min loopback matches (zero desyncs), LTE/WiFi/LAN/bad-network matches, input-delay variants, **fault-injection resync recovery**.

Run: `npm test` (64 total: 26 existing + 37 net + 1 spare).

## Demo

Serve the repo (`npm run dev`) and open `net-demo.html`. Two peers battle in
real time over simulated LTE; the HUD shows live hash comparison. Hit
"💥 Inject desync" to corrupt peer 1 and watch the snapshot resync recover.

## Phase 2 hookup

Replace `SimulatedNetwork` with a WebSocket transport implementing
`UnreliableTransport`. Everything above it (`ReliableLink`, `LockstepPeer`,
hash/snapshot) is transport-agnostic and stays untouched.
