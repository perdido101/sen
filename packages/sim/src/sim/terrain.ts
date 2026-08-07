/**
 * Terrain sampling. The whole planet is one 4096x2048 equirectangular PNG
 * loaded once into a byte array - O(1) lookups, no GIS pipeline, no tile
 * server. The visible map is a separate stylized art layer; data and beauty
 * stay decoupled.
 */

import {
  Biome,
  BIOME_SPEED,
  COLD_WATER_MPS,
  ICE_MPS,
  ICE_SPEED,
  SST_H,
  SST_W,
  WARM_SST,
  WARM_WATER_MPS,
  WARM_WATER_SPEED,
  WATER_SPEED,
  WORLD_H,
  WORLD_W,
  clamp,
  wrapX,
} from './constants.ts';
import type { TerrainData, WorldState } from './types.ts';

/** Shared scratch - sampling happens per storm per frame, so never allocate. */
export interface TerrainSample {
  water: boolean;
  ice: boolean;
  biome: Biome;
  /** Elevation on land, baseline SST on water. */
  b: number;
}

const SCRATCH: TerrainSample = { water: false, ice: false, biome: Biome.Ocean, b: 0 };

const BIOME_OF_G: Record<number, Biome> = {
  0: Biome.Ocean,
  40: Biome.Plains,
  80: Biome.Forest,
  120: Biome.Desert,
  160: Biome.Urban,
  200: Biome.Mountain,
  240: Biome.Ice,
};

function biomeFromG(g: number): Biome {
  const q = Math.round(g / 40) * 40;
  return BIOME_OF_G[q] ?? Biome.Plains;
}

/** Sample the static terrain map. Returns a shared object - copy if you keep it. */
export function sampleTerrain(t: TerrainData, x: number, y: number): TerrainSample {
  // Index off the map's own dimensions, never the compile-time constants, so a
  // mismatched map is a visible error rather than a silent row-0 read.
  const px = Math.floor((wrapX(x) / WORLD_W) * t.w) % t.w;
  const py = clamp(Math.floor((y / WORLD_H) * t.h), 0, t.h - 1);
  const i = (py * t.w + px) * 4;
  const r = t.data[i];
  SCRATCH.water = r < 64;
  SCRATCH.ice = r > 192;
  SCRATCH.biome = biomeFromG(t.data[i + 1]);
  SCRATCH.b = t.data[i + 2];
  return SCRATCH;
}

// ---------------------------------------------------------------------------
// Live sea surface temperature. A real terrain channel, not a flag.
// ---------------------------------------------------------------------------

export function sstIndex(x: number, y: number): number {
  const sx = Math.floor((wrapX(x) / WORLD_W) * SST_W) % SST_W;
  const sy = clamp(Math.floor((y / WORLD_H) * SST_H), 0, SST_H - 1);
  return sy * SST_W + sx;
}

export function sstAt(w: WorldState, x: number, y: number): number {
  return w.sst[sstIndex(x, y)];
}

/** Heat the water you are feeding in. This is what blooms red on every minimap. */
export function heatSst(w: WorldState, x: number, y: number, amount: number): number {
  const i = sstIndex(x, y);
  const before = w.sst[i];
  w.sst[i] = clamp(before + amount, 0, 255);
  // Bleed into the 8 neighbours so the bloom spreads as a field, not a pixel.
  const sy = Math.floor(i / SST_W);
  const sx = i - sy * SST_W;
  const side = amount * 0.35;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = sy + dy;
    if (ny < 0 || ny >= SST_H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = (sx + dx + SST_W) % SST_W;
      const ni = ny * SST_W + nx;
      w.sst[ni] = clamp(w.sst[ni] + side, 0, 255);
    }
  }
  return w.sst[i];
}

/** Decays back toward the PNG baseline at SST_DECAY per second. Called at 10Hz. */
export function decaySst(w: WorldState, dt: number): void {
  const rate = 0.4 * dt;
  const sst = w.sst;
  const base = w.sstBase;
  for (let i = 0; i < sst.length; i++) {
    const d = sst[i] - base[i];
    if (d > rate) sst[i] -= rate;
    else if (d < -rate) sst[i] += rate;
    else sst[i] = base[i];
  }
}

// ---------------------------------------------------------------------------
// The terrain effect table (§1). Rank-dependent water is the map inversion.
// ---------------------------------------------------------------------------

export interface TerrainEffect {
  speedMul: number;
  massPerSec: number;
  water: boolean;
  warm: boolean;
  ice: boolean;
  biome: Biome;
}

const EFFECT: TerrainEffect = {
  speedMul: 1,
  massPerSec: 0,
  water: false,
  warm: false,
  ice: false,
  biome: Biome.Plains,
};

/**
 * @param rank 1-based rank index. The water column is rank-dependent;
 *             everything else is flat.
 */
export function terrainEffect(
  w: WorldState,
  x: number,
  y: number,
  rank: number,
): TerrainEffect {
  const s = sampleTerrain(w.terrain, x, y);
  EFFECT.water = s.water;
  EFFECT.warm = false;
  EFFECT.ice = s.ice;
  EFFECT.biome = s.biome;

  if (s.ice) {
    EFFECT.speedMul = ICE_SPEED;
    EFFECT.massPerSec = ICE_MPS;
    return EFFECT;
  }

  if (s.water) {
    const temp = sstAt(w, x, y);
    const warm = temp >= WARM_SST;
    EFFECT.warm = warm;
    EFFECT.speedMul = warm ? WARM_WATER_SPEED : WATER_SPEED;
    const r = clamp(rank - 1, 0, 6);
    EFFECT.massPerSec = warm ? WARM_WATER_MPS[r] : COLD_WATER_MPS[r];
    return EFFECT;
  }

  EFFECT.speedMul = BIOME_SPEED[s.biome] ?? 1;
  EFFECT.massPerSec = 0;
  return EFFECT;
}

/** Rough continent id from world position, for the Grand Tour badge. */
export function continentOf(x: number, y: number): number {
  // Buckets in world-x space; good enough for "fed on 4 continents".
  const t = x / WORLD_W;
  const north = y < WORLD_H * 0.5;
  if (t < 0.13) return north ? 0 : 1; // Africa N / Africa S
  if (t < 0.33) return 2; // Asia
  if (t < 0.5) return 3; // Oceania / SE Asia
  if (t < 0.72) return 4; // Pacific / Americas W
  if (t < 0.86) return north ? 5 : 6; // N America / S America
  return 7; // Atlantic / Europe
}
