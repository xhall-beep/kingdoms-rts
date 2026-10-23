/**
 * The simulation is tick-based: one tick is the smallest unit of game time.
 * All durations in game data are stored in ticks so results never depend on wall-clock speed.
 */
export const TICK_RATE = 20; // Ticks per game second.

export const secondsToTicks = (seconds: number): number => Math.round(seconds * TICK_RATE);

/**
 * World ticks per simulated second — the rate `world.tick` actually advances.
 * Every driver steps the world at a fixed 1/60 s (Engine fixed step, lockstep
 * session STEP, PvP/replay drivers, tests), so world.tick advances 60 times
 * per sim second. Durations counted in world.tick units — lastCombatTick
 * gaps, the reanimateTicks countdown, momentum/war-horn windows — MUST be
 * denominated in this rate.
 *
 * TICK_RATE (20) is NOT this rate and never denominates world.tick: it is
 * only the storage convention for data-table durations (buildTicks,
 * trainTicks, cooldownTicks), which are converted back to seconds at spawn
 * (`def.buildTicks / TICK_RATE`) and consumed against dt. Confusing the two
 * clocks is a recurring bug family: it made Creeping Blight's delay 1.67 s
 * instead of the designed 5 s and reanimated skeletons live 5 s instead of
 * the designed 15 s (audit 2026-10-22).
 */
export const WORLD_TICKS_PER_SECOND = 60;
