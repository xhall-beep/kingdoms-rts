/**
 * The simulation is tick-based: one tick is the smallest unit of game time.
 * All durations in game data are stored in ticks so results never depend on wall-clock speed.
 */
export const TICK_RATE = 20; // Ticks per game second.

export const secondsToTicks = (seconds: number): number => Math.round(seconds * TICK_RATE);
