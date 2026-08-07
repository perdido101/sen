/**
 * Chunked procedural props.
 *
 * The world is diced into 512x512 cells, generated on demand within range of
 * any storm and seeded by hash(worldSeed, cellX, cellY) so every client
 * produces identical props without touching the world RNG order.
 */

import {
  CHUNK_SIZE,
  CAP_STICKMEN,
  WORLD_H,
  WORLD_W,
  wrapDeltaX,
  wrapX,
} from './constants.ts';
import { Stream, hash3, valueNoise } from './rng.ts';
import { BIOME_SCATTER, PROP_KINDS, pickFromTable } from './props.ts';
import { sampleTerrain } from './terrain.ts';
import { ManState } from './types.ts';
import type { Chunk, Prop, WorldState } from './types.ts';

export const CHUNK_COLS = Math.ceil(WORLD_W / CHUNK_SIZE);
export const CHUNK_ROWS = Math.ceil(WORLD_H / CHUNK_SIZE);

/** Props are generated near any storm; stickmen only near the player. */
export const PROP_RANGE = CHUNK_SIZE * 2.2;
export const MAN_RANGE = CHUNK_SIZE * 2.2;
const KEEP_RANGE = CHUNK_SIZE * 3.4;

export function chunkKey(cx: number, cy: number): number {
  const x = ((cx % CHUNK_COLS) + CHUNK_COLS) % CHUNK_COLS;
  return x + cy * CHUNK_COLS;
}

function chunkCentre(cx: number, cy: number): [number, number] {
  return [
    wrapX(cx * CHUNK_SIZE + CHUNK_SIZE * 0.5),
    cy * CHUNK_SIZE + CHUNK_SIZE * 0.5,
  ];
}

/**
 * Density comes from a value-noise field so props cluster naturally instead of
 * looking like confetti.
 */
function densityAt(x: number, y: number, seed: number): number {
  const n = valueNoise(x / 900, y / 900, seed + 17);
  return 0.35 + n * 1.0;
}

function generateChunk(w: WorldState, cx: number, cy: number): Chunk {
  const key = chunkKey(cx, cy);
  const st = new Stream(hash3(w.seed, cx, cy));
  const props: Prop[] = [];

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;

  // One terrain sample at the chunk centre picks the scatter table; per-prop
  // samples then reject anything that landed in the wrong medium.
  const centre = sampleTerrain(w.terrain, x0 + CHUNK_SIZE / 2, y0 + CHUNK_SIZE / 2);
  const scatter = BIOME_SCATTER[centre.biome] ?? BIOME_SCATTER[1];

  const dens = densityAt(x0, y0, w.seed);
  const n = Math.round(scatter.density * dens);

  for (let i = 0; i < n; i++) {
    const px = x0 + st.next() * CHUNK_SIZE;
    const py = y0 + st.next() * CHUNK_SIZE;
    if (py < 0 || py > WORLD_H) continue;

    const t = sampleTerrain(w.terrain, px, py);
    const id = pickFromTable(scatter.table, st.next());
    const kind = PROP_KINDS[id];

    // Ships belong at sea, everything else on land. Ocean props are edible -
    // the late game needs something to chew on out there.
    const wantsWater = kind.cls === 4 || kind.name === 'island' || kind.name === 'palmislet';
    if (wantsWater !== t.water) continue;
    if (t.ice && !wantsWater) continue;

    props.push({
      x: wrapX(px),
      y: py,
      type: id,
      cls: kind.cls,
      mass: kind.mass,
      r: kind.r,
      alive: true,
    });
  }

  return { cx, cy, key, props, stickmen: [], lastSeen: w.time };
}

// ---------------------------------------------------------------------------
// Stickmen
// ---------------------------------------------------------------------------

function allocStickman(w: WorldState): number {
  for (let i = 0; i < w.stickmen.length; i++) {
    if (!w.stickmen[i].active) return i;
  }
  if (w.stickmen.length >= CAP_STICKMEN) return -1;
  w.stickmen.push({
    x: 0, y: 0, vx: 0, vy: 0, state: ManState.Idle, ph: 0, h: 1, c: 0,
    hat: false, bike: false, chaser: false, active: false, chunk: -1,
  });
  return w.stickmen.length - 1;
}

export function spawnStickman(
  w: WorldState,
  st: Stream,
  x: number,
  y: number,
  chunk: number,
): number {
  const i = allocStickman(w);
  if (i < 0) return -1;
  const m = w.stickmen[i];
  m.x = wrapX(x);
  m.y = y;
  m.vx = 0;
  m.vy = 0;
  m.state = ManState.Idle;
  m.ph = st.next() * Math.PI * 2;
  m.h = 0.8 + st.next() * 0.4;
  m.c = st.int(0, 5);
  m.hat = st.chance(0.15);
  m.bike = st.chance(0.08);
  // The rare one who runs toward you holding a camera. Worth 5x mass.
  m.chaser = st.chance(0.012);
  m.active = true;
  m.chunk = chunk;
  return i;
}

function populateChunk(w: WorldState, c: Chunk): void {
  if (c.stickmen.length > 0) return;
  const st = new Stream(hash3(w.seed ^ 0x51c, c.cx, c.cy));
  const t = sampleTerrain(w.terrain, c.cx * CHUNK_SIZE + 256, c.cy * CHUNK_SIZE + 256);
  if (t.water || t.ice) return;

  // Urban chunks carry a dense crowd; the countryside is sparse. The pool cap
  // is what actually bounds this, so lean generous - hundreds of stickmen on
  // screen is the whole point.
  const base = t.biome === 4 ? 60 : t.biome === 1 ? 22 : 10;
  const n = Math.round(base * (0.5 + st.next()));
  for (let i = 0; i < n; i++) {
    // Cluster near where buildings would be rather than spreading evenly.
    const gx = st.next();
    const gy = st.next();
    const jx = (st.next() - 0.5) * 90;
    const jy = (st.next() - 0.5) * 90;
    const x = c.cx * CHUNK_SIZE + gx * CHUNK_SIZE + jx;
    const y = c.cy * CHUNK_SIZE + gy * CHUNK_SIZE + jy;
    if (y < 0 || y > WORLD_H) continue;
    // The chunk centre being land is not enough - a coastal chunk would put
    // half its crowd in the sea.
    const at = sampleTerrain(w.terrain, x, y);
    if (at.water || at.ice) continue;
    const id = spawnStickman(w, st, x, y, c.key);
    if (id < 0) break;
    c.stickmen.push(id);
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

function ensureChunk(w: WorldState, cx: number, cy: number): Chunk | null {
  if (cy < 0 || cy >= CHUNK_ROWS) return null;
  const key = chunkKey(cx, cy);
  let c = w.chunks.get(key);
  if (c === undefined) {
    c = generateChunk(w, ((cx % CHUNK_COLS) + CHUNK_COLS) % CHUNK_COLS, cy);
    w.chunks.set(key, c);
  }
  c.lastSeen = w.time;
  return c;
}

/**
 * Load chunks around every live storm, populate the ones near the player with
 * stickmen, and unload anything nobody is near. Deterministic: driven entirely
 * by storm positions, which are themselves deterministic.
 */
export function streamChunks(w: WorldState): void {
  const player = w.storms[w.playerId];

  for (let s = 0; s < w.storms.length; s++) {
    const st = w.storms[s];
    if (!st.alive) continue;
    const c0 = Math.floor((st.x - PROP_RANGE) / CHUNK_SIZE);
    const c1 = Math.floor((st.x + PROP_RANGE) / CHUNK_SIZE);
    const r0 = Math.floor((st.y - PROP_RANGE) / CHUNK_SIZE);
    const r1 = Math.floor((st.y + PROP_RANGE) / CHUNK_SIZE);
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = ensureChunk(w, cx, cy);
        if (c === null) continue;
        if (player !== undefined && player.alive) {
          const [px, py] = chunkCentre(c.cx, c.cy);
          const dx = wrapDeltaX(player.x, px);
          const dy = py - player.y;
          if (dx * dx + dy * dy < MAN_RANGE * MAN_RANGE) populateChunk(w, c);
        }
      }
    }
  }

  // Unload far cells and pool the objects.
  for (const [key, c] of w.chunks) {
    const [px, py] = chunkCentre(c.cx, c.cy);
    let near = false;
    for (let s = 0; s < w.storms.length; s++) {
      const st = w.storms[s];
      if (!st.alive) continue;
      const dx = wrapDeltaX(st.x, px);
      const dy = py - st.y;
      if (dx * dx + dy * dy < KEEP_RANGE * KEEP_RANGE) {
        near = true;
        break;
      }
    }
    if (near) continue;
    for (let i = 0; i < c.stickmen.length; i++) {
      const m = w.stickmen[c.stickmen[i]];
      if (m !== undefined && m.chunk === key) m.active = false;
    }
    w.chunks.delete(key);
  }
}
