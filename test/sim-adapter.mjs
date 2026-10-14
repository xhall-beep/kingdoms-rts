/**
 * sim-adapter.mjs — SimulationWorld adapter bridging the standalone lockstep
 * harness (~/test_lockstep_replay.mjs) to the real Kingdoms engine.
 *
 * Contract: step(cmd) / hash() / serialize() / deserialize(bytes).
 * Harness tags: NOOP 0, MOVE 1, SPAWN 2, ATTACK 3, HARVEST 4, TICK_STEP 9, SURRENDER 10.
 * One harness turn (250ms) = 15 fixed 1/60 engine steps (matches net STEPS_PER_TURN).
 *
 * NOTE: several engine files use extensionless imports (bundler resolution),
 * so plain node CANNOT import this file directly. Bundle first (or `npm run test:lockstep`):
 *   npx esbuild test/sim-adapter.mjs --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/sim-adapter.bundle.mjs
 *   SIM_MODULE=$HOME/kingdoms-real/node_modules/.cache/sim-adapter.bundle.mjs \
 *     node $HOME/test_lockstep_replay.mjs 1337
 */
import { World } from '../src/core/World.ts';
import { seedScenario } from '../src/scenario.ts';
import { hashWorldState } from '../src/net/hash.ts';
import { snapshotWorld, restoreWorld } from '../src/net/snapshot.ts';
import { ProductionSystemImpl } from '../src/systems/production.ts';
import { GatherSystemImpl } from '../src/systems/gather.ts';
import { CombatSystemImpl } from '../src/systems/combat.ts';
import { VisionSystemImpl } from '../src/systems/vision.ts';
import { VictorySystemImpl } from '../src/systems/victory.ts';
import { MovementSystemImpl } from '../src/systems/movement.ts';
import { orderMove } from '../src/systems/movement.ts';
import { orderAttack } from '../src/systems/combat.ts';
import { placeStructure } from '../src/world/construction.ts';

const TAG = { NOOP: 0, MOVE: 1, SPAWN: 2, ATTACK: 3, HARVEST: 4, TICK_STEP: 9, SURRENDER: 10 };
const STEPS_PER_TURN = 15;
const FIXED_DT = 1 / 60;

export class SimulationWorld {
  constructor() {
    this.world = new World();
    // Decisions first, steering last (same order as main.ts composeGame, minus OpponentAI).
    this.world.registerSystem(new ProductionSystemImpl());
    this.world.registerSystem(new GatherSystemImpl());
    this.world.registerSystem(new CombatSystemImpl());
    this.world.registerSystem(new VisionSystemImpl());
    this.world.registerSystem(new VictorySystemImpl());
    this.world.registerSystem(new MovementSystemImpl());
    seedScenario(this.world, 'human', 'orc');
    this.turn = 0;
  }

  teamOf(playerId) {
    return playerId === 1 ? 0 : playerId === 2 ? 1 : -1;
  }

  step(cmd) {
    if (!cmd || typeof cmd.turn !== 'number') {
      throw new Error(`Invalid command passed to step(): ${JSON.stringify(cmd)}`);
    }
    if (cmd.turn > this.turn) this.turn = cmd.turn | 0;
    const w = this.world;
    if (w.winner !== -1) return; // match over: mirror reference early-out
    const payload = cmd.payload || {};
    const team = this.teamOf(cmd.playerId);
    switch (cmd.tag) {
      case TAG.MOVE: {
        const id = payload.entityId | 0;
        if (w.entities.has(id)) orderMove(w, id, (payload.targetX | 0) / 1000, (payload.targetY | 0) / 1000);
        break;
      }
      case TAG.HARVEST: {
        if (team === 0 || team === 1) w.gold[team] += payload.amount | 0;
        break;
      }
      case TAG.SPAWN: {
        if (team === 0 || team === 1) {
          placeStructure(w, team, payload.unitType === 2 ? 'farm' : 'barracks',
            (payload.x | 0) / 1000, (payload.y | 0) / 1000);
        }
        break;
      }
      case TAG.ATTACK: {
        const a = payload.attackerId | 0;
        const t = payload.targetId | 0;
        if (w.entities.has(a) && w.entities.has(t)) orderAttack(w, a, t);
        break;
      }
      case TAG.TICK_STEP: {
        for (let i = 0; i < STEPS_PER_TURN; i += 1) w.update(FIXED_DT);
        break;
      }
      case TAG.SURRENDER: {
        if (cmd.playerId === 1) w.winner = 1;
        else if (cmd.playerId === 2) w.winner = 0;
        break;
      }
      default: break;
    }
  }

  hash() {
    return Number(hashWorldState(this.world) & 0xffffffffn);
  }

  serialize() {
    const bytes = snapshotWorld(this.world);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  deserialize(bytes) {
    restoreWorld(this.world, bytes);
  }
}
