/**
 * World construction. Everything here is deterministic given (seed, terrain).
 */

import {
  CAP_LOOSE_DEBRIS,
  CAP_STICKMEN,
  MIN_MASS,
  SST_H,
  SST_W,
  START_MASS,
  WORLD_H,
  WORLD_W,
  EQUATOR_Y,
  clamp,
  wrapX,
} from './constants.ts';
import { buildCities } from './cities.ts';
import { LA_NINA, STORM_NAMES } from './names.ts';
import { rand, randRange } from './rng.ts';
import { createHash } from './spatial.ts';
import { sampleTerrain } from './terrain.ts';
import type { LooseDebris, Storm, StormStats, TerrainData, WorldState } from './types.ts';

export interface WorldOptions {
  seed: number;
  terrain: TerrainData;
  bots: number;
  playerName?: string;
  instantDeathOnShred?: boolean;
}

function emptyStats(): StormStats {
  return {
    peakMass: START_MASS,
    shredsTaken: 0,
    shredsDealt: 0,
    cows: 0,
    trees: 0,
    cars: 0,
    ships: 0,
    stickmen: 0,
    citiesEmptied: 0,
    t1Emptied: 0,
    equatorCrossings: 0,
    distanceX: 0,
    aliveTime: 0,
    seaTime: 0,
    boostTime: 0,
    chaserCaught: 0,
    continents: 0,
    touchedNorthCap: false,
    touchedSouthCap: false,
    greenlandTime: 0,
    minMassSeen: START_MASS,
    timeToElNino: -1,
    maxHeatCell: 0,
    carsIn10s: 0,
    carWindow: [],
  };
}

export function makeStorm(id: number, kind: 'player' | 'bot', name: string, x: number, y: number, mass: number): Storm {
  return {
    id,
    kind,
    name,
    alive: true,
    x,
    y,
    ang: 0,
    mass,
    boosting: false,
    boostEjectTimer: 0,
    spinDir: y < EQUATOR_Y ? -1 : 1,
    spinFlip: 0,
    fieldRot: 0,
    invuln: 0,
    hurt: 0,
    field: [],
    drainingCity: -1,
    winTimer: 0,
    rank: 1,
    botState: 0,
    botTimer: 0,
    botTarget: -1,
    botPersonality: 0,
    isLaNina: false,
    farAccum: 0,
    stats: emptyStats(),
  };
}

/**
 * Find a land spawn. Two passes: first insist on good feeding ground well
 * clear of the poles, then relax to any land at all.
 *
 * A Dust Devil carries only 2 mass of headroom above the dissipation floor, so
 * spawning within a few seconds' flight of an ice cap is a two-second run.
 * Start people where the food is.
 */
export function findLandSpawn(w: WorldState, tries = 220): [number, number] {
  const ICE_MARGIN = 700;
  for (let i = 0; i < tries; i++) {
    const x = rand(w) * WORLD_W;
    const y = randRange(w, WORLD_H * 0.3, WORLD_H * 0.7);
    const t = sampleTerrain(w.terrain, x, y);
    if (t.water || t.ice) continue;
    // Mountains are a bad opening hand: slow, sparse, and bots avoid them.
    if (t.biome === 5) continue;
    if (
      sampleTerrain(w.terrain, x, y - ICE_MARGIN).ice ||
      sampleTerrain(w.terrain, x, y + ICE_MARGIN).ice
    ) {
      continue;
    }
    return [x, y];
  }
  for (let i = 0; i < tries; i++) {
    const x = rand(w) * WORLD_W;
    const y = randRange(w, WORLD_H * 0.25, WORLD_H * 0.75);
    const t = sampleTerrain(w.terrain, x, y);
    if (!t.water && !t.ice) return [x, y];
  }
  return [WORLD_W * 0.5, EQUATOR_Y];
}

export function createWorld(opts: WorldOptions): WorldState {
  const sstBase = new Float32Array(SST_W * SST_H);
  const sst = new Float32Array(SST_W * SST_H);

  // Downsample the PNG's baseline SST channel into the live overlay grid.
  const t = opts.terrain;
  for (let sy = 0; sy < SST_H; sy++) {
    for (let sx = 0; sx < SST_W; sx++) {
      const px = Math.floor(((sx + 0.5) / SST_W) * t.w);
      const py = Math.floor(((sy + 0.5) / SST_H) * t.h);
      const i = (py * t.w + px) * 4;
      const water = t.data[i] < 64;
      const v = water ? t.data[i + 2] : 0;
      sstBase[sy * SST_W + sx] = v;
      sst[sy * SST_W + sx] = v;
    }
  }

  const debris: LooseDebris[] = [];
  for (let i = 0; i < CAP_LOOSE_DEBRIS; i++) {
    debris.push({ x: 0, y: 0, vx: 0, vy: 0, mass: 0, type: 0, cls: 0, life: 0, active: false });
  }

  const w: WorldState = {
    seed: opts.seed | 0,
    rng: opts.seed | 0,
    tick: 0,
    time: 0,
    storms: [],
    debris,
    stickmen: [],
    cities: buildCities(),
    chunks: new Map(),
    terrain: opts.terrain,
    sst,
    sstBase,
    sstAccum: 0,
    events: [],
    playerId: 0,
    winner: -1,
    over: false,
    instantDeathOnShred: opts.instantDeathOnShred ?? false,
    debrisCursor: 0,
    _hash: createHash(CAP_LOOSE_DEBRIS + CAP_STICKMEN + 6000),
  };

  // Player first, so playerId is always 0.
  const [px, py] = findLandSpawn(w);
  const player = makeStorm(0, 'player', opts.playerName ?? 'You', px, py, START_MASS);
  player.ang = rand(w) * Math.PI * 2;
  w.storms.push(player);

  spawnBots(w, opts.bots);
  return w;
}

export function spawnBots(w: WorldState, count: number): void {
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const [x, y] = findLandSpawn(w);
    let name = STORM_NAMES[Math.floor(rand(w) * STORM_NAMES.length)];
    let guard = 0;
    while (used.has(name) && guard++ < 40) {
      name = STORM_NAMES[Math.floor(rand(w) * STORM_NAMES.length)];
    }
    used.add(name);

    // A spread of starting sizes so the map is not uniform.
    const mass = randRange(w, 12, 40 + i * 6);
    const s = makeStorm(w.storms.length, 'bot', name, x, y, mass);
    s.ang = rand(w) * Math.PI * 2;
    s.botPersonality = Math.floor(rand(w) * 4);
    w.storms.push(s);
  }
  designateLaNina(w);
}

/**
 * La Nina is always the largest bot in the run: a name, a tint, and a
 * personality weight. She is the closest thing this game has to a boss.
 */
export function designateLaNina(w: WorldState): void {
  let best = -1;
  let bestMass = -1;
  for (let i = 0; i < w.storms.length; i++) {
    const s = w.storms[i];
    if (s.kind !== 'bot' || !s.alive) continue;
    if (s.mass > bestMass) {
      bestMass = s.mass;
      best = i;
    }
  }
  for (let i = 0; i < w.storms.length; i++) {
    const s = w.storms[i];
    if (s.kind !== 'bot') continue;
    if (i === best) {
      if (!s.isLaNina) {
        s.isLaNina = true;
        s.name = LA_NINA;
        s.botPersonality = 2; // Hunter
        s.mass = Math.max(s.mass, bestMass * 1.15);
      }
    } else if (s.isLaNina) {
      s.isLaNina = false;
      s.name = STORM_NAMES[Math.floor(rand(w) * STORM_NAMES.length)];
    }
  }
}

/** Respawn a dead bot far from the player so the arena stays populated. */
export function respawnBot(w: WorldState, s: Storm): void {
  const [x, y] = findLandSpawn(w);
  s.x = wrapX(x);
  s.y = clamp(y, 4, WORLD_H - 4);
  s.mass = Math.max(MIN_MASS + 4, randRange(w, 12, 45));
  s.alive = true;
  s.field.length = 0;
  s.invuln = 1.0;
  s.hurt = 0;
  s.winTimer = 0;
  s.drainingCity = -1;
  s.botState = 0;
  s.botTimer = 0;
  s.botTarget = -1;
  s.stats = emptyStats();
  s.name = STORM_NAMES[Math.floor(rand(w) * STORM_NAMES.length)];
  s.isLaNina = false;
}
