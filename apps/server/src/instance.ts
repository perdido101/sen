/**
 * One world instance = one planet.
 *
 * This is the Brief 1 simulation, imported and stepped. It is not a fork and
 * it is not a reimplementation: every rule the client knows is the same code
 * object the server is running, which is the entire reason the server is an
 * adapter rather than a second game to keep in sync.
 *
 * A human and a bot are indistinguishable in here. Both arrive as an Input.
 */

import {
  CAP_BOTS,
  FIXED_DT,
  START_MASS,
  createWorld,
  fieldRadius,
  makeStorm,
  respawnBot,
  step,
  wrapDeltaX,
  wrapDist,
  designateLaNina,
  findLandSpawn,
  botInput,
  rankOf,
} from '@sen/sim';
import type { Input, Storm, TerrainData, WorldState } from '@sen/sim';
import { Flag, type NetEntity } from '@sen/protocol';

export interface InstanceOptions {
  id: string;
  seed: number;
  terrain: TerrainData;
  region: string;
  /** Humans allowed. Brief 2 caps this at 60. */
  maxHumans: number;
  /** Bots backfill to this many total storms. */
  targetStorms: number;
}

export interface Client {
  id: number;
  /** Storm id in the world. */
  stormId: number;
  name: string;
  /** Latest input the server has consumed. */
  input: Input;
  lastSeq: number;
  /** View half-extents in world units, from the client's viewport. */
  viewW: number;
  viewH: number;
  /** Last snapshot this client acknowledged, for delta compression. */
  baseline: Map<number, NetEntity> | null;
  baseTick: number;
  /** Anti-cheat counters, see antiCheat.ts. */
  packets: number;
  boostToggles: number;
  windowStart: number;
  flagged: string[];
  /** Replay: seed plus every input, which is the ground truth for Phase 14. */
  inputLog: number[];
  /** Set when the log hit its cap, so a partial validation is not read as a full one. */
  inputLogTruncated: boolean;
  joinedAt: number;
}

/** Area of interest: view plus the brief's 400-unit margin. */
const AOI_MARGIN = 400;

/**
 * How much of a run's input is kept for replay validation.
 *
 * Three numbers per packet at 30Hz is 720 bytes a second, which over an hour
 * is 2.6MB per client and 155MB across a full instance - a leak that a soak
 * finds and a launch day finds harder. Runs are 90 seconds to 8 minutes, so
 * five minutes of input covers most of them whole; anything longer is
 * validated over its first five minutes and marked truncated. The HEAD is
 * what is kept, deliberately: the re-sim starts at tick 0 and a log missing
 * its beginning cannot be replayed at all.
 */
const MAX_INPUT_LOG = 5 * 60 * 30 * 3;

export class Instance {
  readonly world: WorldState;
  readonly clients = new Map<number, Client>();
  readonly id: string;
  readonly region: string;
  readonly seed: number;
  readonly maxHumans: number;
  readonly targetStorms: number;

  /** Reused every tick so the hot loop allocates nothing. */
  private inputs = new Map<number, Input>();
  private botInputs = new Map<number, Input>();
  private freeStormIds: number[] = [];

  tick = 0;
  createdAt = Date.now();

  constructor(opts: InstanceOptions) {
    this.id = opts.id;
    this.region = opts.region;
    this.seed = opts.seed;
    this.maxHumans = opts.maxHumans;
    this.targetStorms = opts.targetStorms;

    // The world is built with its full bot complement; humans then take over
    // bot slots as they join, which is why a half-empty instance still looks
    // and plays like a busy one.
    this.world = createWorld({
      seed: opts.seed,
      terrain: opts.terrain,
      bots: Math.min(CAP_BOTS, opts.targetStorms - 1),
    });
  }

  get humans(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.maxHumans;
  }

  // -------------------------------------------------------------------- join

  /**
   * Join mid-run at Dust Devil rank in a safe spawn: no rival within 1200
   * units, and not inside a city.
   */
  private safeSpawn(): [number, number] {
    for (let attempt = 0; attempt < 60; attempt++) {
      const [x, y] = findLandSpawn(this.world);
      let clear = true;
      for (const s of this.world.storms) {
        if (!s.alive) continue;
        if (wrapDist(x, y, s.x, s.y) < 1200) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      let inCity = false;
      for (const c of this.world.cities) {
        if (wrapDist(x, y, c.x, c.y) < c.r) {
          inCity = true;
          break;
        }
      }
      if (inCity) continue;
      return [x, y];
    }
    return findLandSpawn(this.world);
  }

  addClient(clientId: number, name: string): Client {
    const [x, y] = this.safeSpawn();

    // Prefer recycling a storm slot so entity ids stay inside a uint16 and
    // the arrays do not grow without bound over an instance's lifetime.
    let stormId = this.freeStormIds.pop() ?? -1;
    if (stormId >= 0) {
      const s = this.world.storms[stormId];
      respawnBot(this.world, s);
      s.kind = 'player';
      s.name = name;
      s.x = x;
      s.y = y;
      s.mass = START_MASS;
      s.isLaNina = false;
    } else {
      stormId = this.world.storms.length;
      const s = makeStorm(stormId, 'player', name, x, y, START_MASS);
      s.invuln = 2;
      this.world.storms.push(s);
    }

    const c: Client = {
      id: clientId,
      stormId,
      name,
      input: { steerAngle: 0, boosting: false },
      lastSeq: -1,
      viewW: 1600,
      viewH: 900,
      baseline: null,
      baseTick: 0,
      packets: 0,
      boostToggles: 0,
      windowStart: Date.now(),
      flagged: [],
      inputLog: [],
      inputLogTruncated: false,
      joinedAt: Date.now(),
    };
    this.clients.set(clientId, c);
    return c;
  }

  removeClient(clientId: number): Client | undefined {
    const c = this.clients.get(clientId);
    if (c === undefined) return undefined;
    this.clients.delete(clientId);

    // Hand the storm back to the bots rather than deleting it: an instance
    // that visibly empties out as people leave is the thing bot backfill
    // exists to prevent.
    const s = this.world.storms[c.stormId];
    if (s !== undefined) {
      s.kind = 'bot';
      respawnBot(this.world, s);
      designateLaNina(this.world);
    }
    return c;
  }

  // ------------------------------------------------------------------- input

  applyInput(c: Client, seq: number, steerAngle: number, boosting: boolean): void {
    // uint16 sequence numbers wrap; accept anything within half the space
    // ahead of the last one and drop the rest as out of order or replayed.
    const ahead = (seq - c.lastSeq) & 0xffff;
    if (c.lastSeq >= 0 && (ahead === 0 || ahead > 0x7fff)) return;
    c.lastSeq = seq;

    if (c.input.boosting !== boosting) c.boostToggles++;
    c.input.steerAngle = steerAngle;
    c.input.boosting = boosting;

    // Replay log: tick, angle, boost. Re-simmed server-side for Phase 14.
    //
    // Only while there is a run to validate. A client whose storm has
    // dissipated keeps sending input - it is still holding a mouse - and
    // logging that is recording nothing at a steady 720 bytes a second.
    const s = this.world.storms[c.stormId];
    if (s === undefined || !s.alive) return;
    if (c.inputLog.length >= MAX_INPUT_LOG) {
      c.inputLogTruncated = true;
      return;
    }
    c.inputLog.push(this.tick, steerAngle, boosting ? 1 : 0);
  }

  // -------------------------------------------------------------------- step

  step(): void {
    this.inputs.clear();

    for (const c of this.clients.values()) {
      this.inputs.set(c.stormId, c.input);
    }

    // Bots fill everything that is not a human. They speak the same Input, so
    // the sim cannot tell the difference and neither can the netcode.
    for (const s of this.world.storms) {
      if (s.kind !== 'bot' || !s.alive) continue;
      let bi = this.botInputs.get(s.id);
      if (bi === undefined) {
        bi = { steerAngle: 0, boosting: false };
        this.botInputs.set(s.id, bi);
      }
      botInput(this.world, s, FIXED_DT, bi);
      this.inputs.set(s.id, bi);
    }

    step(this.world, this.inputs);
    this.tick++;
  }

  // --------------------------------------------------------------------- AOI

  /**
   * Everything the client can see, plus a margin.
   *
   * Non-negotiable per the brief: the world holds thousands of entities and a
   * full-state broadcast is a hundred times over budget. Both sides of the
   * wrap seam count as near, which is the bug this whole codebase keeps
   * having to re-learn.
   */
  entitiesFor(c: Client, out: NetEntity[]): NetEntity[] {
    out.length = 0;
    const me = this.world.storms[c.stormId];
    if (me === undefined) return out;

    const halfW = c.viewW * 0.5 + AOI_MARGIN;
    const halfH = c.viewH * 0.5 + AOI_MARGIN;

    // The client's own storm is always sent, even dead: it is the only way it
    // finds out that it died rather than that it stopped being visible.
    if (!me.alive) {
      out.push({
        id: me.id,
        x: me.x,
        y: me.y,
        ang: me.ang,
        mass: 0,
        flags: Flag.Dead,
      });
    }

    for (const s of this.world.storms) {
      if (!s.alive) continue;
      const dx = wrapDeltaX(me.x, s.x);
      const dy = s.y - me.y;
      // A storm's field reaches well past its centre, so admit anything whose
      // debris could be on screen even when the eye is not.
      const reach = fieldRadius(s.mass);
      if (Math.abs(dx) > halfW + reach || Math.abs(dy) > halfH + reach) continue;
      out.push({
        id: s.id,
        x: s.x,
        y: s.y,
        ang: s.ang,
        mass: s.mass,
        flags: stormFlags(s),
      });
    }

    // Loose debris is the other half of what a client must see: it is the
    // richest food on the map and it is what a kill leaves behind.
    for (let i = 0; i < this.world.debris.length; i++) {
      const d = this.world.debris[i];
      if (!d.active) continue;
      const dx = wrapDeltaX(me.x, d.x);
      const dy = d.y - me.y;
      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;
      out.push({
        // Debris ids live above the storm range so the two never collide.
        id: DEBRIS_ID_BASE + i,
        x: d.x,
        y: d.y,
        ang: 0,
        mass: d.mass,
        flags: Flag.Debris,
      });
    }

    return out;
  }

  stats(): { humans: number; storms: number; tick: number; region: string; id: string } {
    let alive = 0;
    for (const s of this.world.storms) if (s.alive) alive++;
    return {
      humans: this.clients.size,
      storms: alive,
      tick: this.tick,
      region: this.region,
      id: this.id,
    };
  }
}

export const DEBRIS_ID_BASE = 4096;

export function stormFlags(s: Storm): number {
  let f = 0;
  if (s.boosting) f |= Flag.Boosting;
  if (s.spinDir > 0) f |= Flag.Southern;
  if (s.invuln > 0) f |= Flag.Invuln;
  if (s.isLaNina) f |= Flag.LaNina;
  if (s.drainingCity >= 0) f |= Flag.Draining;
  return f;
}

export function rankOfStorm(s: Storm): number {
  return rankOf(s.mass);
}
