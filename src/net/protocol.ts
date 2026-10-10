/**
 * PvP netcode protocol — Phase 1: Loopback.
 *
 * Deterministic lockstep: only player inputs cross the wire.
 * Each client simulates the full game locally. No state streaming.
 *
 * Turn structure: 4 turns/second. Each turn, clients submit input
 * bundles for turn N+2 (2-turn input delay for network latency).
 */

// A single player input (command)
export interface NetInput {
  turn: number        // Which turn this input is for
  player: 0 | 1       // Which player sent it
  cmds: NetCommand[]  // Commands in this bundle
}

// Serializable command (subset of game commands safe for network)
export interface NetCommand {
  type: string
  // Command-specific fields (all plain JSON-serializable)
  [key: string]: unknown
}

// Turn bundle exchanged each turn
export interface TurnBundle {
  turn: number
  inputs: [NetInput | null, NetInput | null] // [p0, p1] — null = no input
  hash?: number // State hash for desync detection (every 40 turns)
}

// Network message types
export type NetMessage =
  | { kind: 'hello'; playerId: string; name: string }
  | { kind: 'turn'; bundle: TurnBundle }
  | { kind: 'hash'; turn: number; hash: number; player: 0 | 1 }
  | { kind: 'pause'; player: 0 | 1 }
  | { kind: 'resume'; player: 0 | 1 }
  | { kind: 'surrender'; player: 0 | 1 }
  | { kind: 'disconnect'; player: 0 | 1 }
  | { kind: 'reconnect'; player: 0 | 1; fromTurn: number }

/** Serialize a turn bundle for the wire (compact JSON). */
export function serializeBundle(bundle: TurnBundle): string {
  return JSON.stringify(bundle)
}

/** Deserialize a turn bundle from the wire. */
export function deserializeBundle(data: string): TurnBundle {
  return JSON.parse(data) as TurnBundle
}
