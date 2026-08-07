/**
 * Uniform spatial hash at 128 unit cells. Never O(n^2).
 * Rebuilt in place every frame - the backing arrays are allocated once.
 */

import { SPATIAL_CELL, WORLD_W, wrapX } from './constants.ts';
import type { SpatialHash } from './types.ts';

const COLS = Math.ceil(WORLD_W / SPATIAL_CELL);

export function createHash(capacity: number): SpatialHash {
  return {
    cells: new Map(),
    ix: new Float64Array(capacity),
    iy: new Float64Array(capacity),
    kind: new Uint8Array(capacity),
    ref: new Int32Array(capacity),
    count: 0,
  };
}

function cellKey(cx: number, cy: number): number {
  return ((cx % COLS) + COLS) % COLS + cy * COLS * 2;
}

export function clearHash(h: SpatialHash): void {
  // Reuse the arrays rather than dropping them; only the buckets reset.
  for (const arr of h.cells.values()) arr.length = 0;
  h.count = 0;
}

export function insert(h: SpatialHash, x: number, y: number, kind: number, ref: number): void {
  const i = h.count;
  if (i >= h.ix.length) return; // hard cap, never grow in the hot loop
  h.ix[i] = x;
  h.iy[i] = y;
  h.kind[i] = kind;
  h.ref[i] = ref;
  h.count++;

  const cx = Math.floor(wrapX(x) / SPATIAL_CELL);
  const cy = Math.floor(y / SPATIAL_CELL);
  const k = cellKey(cx, cy);
  let bucket = h.cells.get(k);
  if (bucket === undefined) {
    bucket = [];
    h.cells.set(k, bucket);
  }
  bucket.push(i);
}

/**
 * Collect indices within `r` of (x,y) into `out` (an array reused by the
 * caller). Honours horizontal wrap. Returns the number written.
 */
export function query(
  h: SpatialHash,
  x: number,
  y: number,
  r: number,
  out: number[],
): number {
  out.length = 0;
  const c0 = Math.floor((wrapX(x) - r) / SPATIAL_CELL);
  const c1 = Math.floor((wrapX(x) + r) / SPATIAL_CELL);
  const r0 = Math.floor((y - r) / SPATIAL_CELL);
  const r1 = Math.floor((y + r) / SPATIAL_CELL);
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const bucket = h.cells.get(cellKey(cx, cy));
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
    }
  }
  return out.length;
}
