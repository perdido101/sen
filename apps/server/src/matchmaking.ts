/**
 * Phase 12 - instances, matchmaking, bot backfill.
 *
 * One world instance is one planet, capped at 60 humans and backfilled with
 * bots to ~80 total storms. The backfill is the highest-leverage thing in this
 * file: for the first months there will be 4 humans and 76 bots, and an empty
 * .io game is a dead .io game. The bots already exist and already speak Input,
 * so this costs nothing.
 */

import type { TerrainData } from '@sen/sim';
import { Instance } from './instance.ts';

export interface PoolOptions {
  terrain: TerrainData;
  region: string;
  maxHumans: number;
  targetStorms: number;
  /** Spin up a new instance once the fullest one passes this occupancy. */
  spawnThreshold: number;
  /** Seed source, so a pool is reproducible in tests. */
  seedFor: (index: number) => number;
}

export class InstancePool {
  readonly instances: Instance[] = [];
  private nextIndex = 0;

  private opts: PoolOptions;

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.spawn();
  }

  private spawn(): Instance {
    const i = this.nextIndex++;
    const inst = new Instance({
      id: `${this.opts.region}-${i}`,
      seed: this.opts.seedFor(i),
      terrain: this.opts.terrain,
      region: this.opts.region,
      maxHumans: this.opts.maxHumans,
      targetStorms: this.opts.targetStorms,
    });
    this.instances.push(inst);
    return inst;
  }

  /**
   * Join the least-full instance in region with room, and spin up a new one
   * once everything is past the threshold. Least-full rather than most-full is
   * deliberate: it spreads load, and an instance that is nearly capped is the
   * one most likely to reject a join mid-handshake.
   */
  pick(): Instance {
    let best: Instance | null = null;
    for (const inst of this.instances) {
      if (inst.full) continue;
      if (best === null || inst.humans < best.humans) best = inst;
    }

    if (best === null) return this.spawn();
    if (best.humans >= this.opts.maxHumans * this.opts.spawnThreshold) return this.spawn();
    return best;
  }

  step(): void {
    for (const inst of this.instances) inst.step();
  }

  /** Retire empty instances, always keeping one warm to join. */
  reap(): void {
    for (let i = this.instances.length - 1; i >= 0; i--) {
      if (this.instances.length <= 1) break;
      const inst = this.instances[i];
      if (inst.humans === 0 && Date.now() - inst.createdAt > 60_000) {
        this.instances.splice(i, 1);
      }
    }
  }

  get totalHumans(): number {
    let n = 0;
    for (const i of this.instances) n += i.humans;
    return n;
  }
}

/**
 * Regions the client pings on load, picking the lowest. Deployment supplies
 * the hostnames; this list is what the client is offered.
 */
export const REGIONS = ['eu-west', 'us-east', 'ap-southeast'] as const;
export type Region = (typeof REGIONS)[number];
