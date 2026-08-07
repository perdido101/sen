/**
 * Cities: the big feed, and the moment you are most killable.
 *
 * ~120 real cities by lat/lon. Each generates a deterministic block grid -
 * streets and building footprints - which flattens progressively as the
 * reserve drains, then rebuilds in reverse over 90 seconds. The map has a
 * rhythm, not a one-time strip-mine.
 */

import { CITY_DATA } from '../data/cities.ts';
import {
  CAP_DETAIL_CITIES,
  CITY_DRAIN_RATE,
  CITY_RADIUS,
  CITY_REBUILD_TIME,
  CITY_RESERVE_PER_TIER,
  CITY_FEED_MPS,
  latToY,
  lonToX,
  wrapDist2,
} from './constants.ts';
import { Stream, hash3 } from './rng.ts';
import type { Building, City, SimEvent, WorldState } from './types.ts';

export function buildCities(): City[] {
  const out: City[] = [];
  for (let i = 0; i < CITY_DATA.length; i++) {
    const d = CITY_DATA[i];
    const reserve = d.t * CITY_RESERVE_PER_TIER;
    out.push({
      id: i,
      name: d.n,
      tier: d.t,
      x: lonToX(d.lon),
      y: latToY(d.lat),
      r: CITY_RADIUS[d.t],
      reserveMax: reserve,
      reserve,
      rebuild: 0,
      buildings: [],
      detailed: false,
      emptiedBy: -1,
    });
  }
  return out;
}

const BUILDINGS_PER_TIER = [0, 210, 120, 64];

/**
 * A deterministic block grid: streets on a jittered lattice, buildings as
 * top-down footprints inside each block.
 */
export function detailCity(c: City): void {
  if (c.detailed) return;
  c.detailed = true;
  const st = new Stream(hash3(0xc17e5, c.id, c.tier));
  const target = BUILDINGS_PER_TIER[c.tier];
  const blocks = Math.ceil(Math.sqrt(target / 3));
  const step = (c.r * 1.5) / blocks;
  const out: Building[] = [];

  for (let by = 0; by < blocks; by++) {
    for (let bx = 0; bx < blocks; bx++) {
      const ox = c.x + (bx - blocks / 2 + 0.5) * step;
      const oy = c.y + (by - blocks / 2 + 0.5) * step;
      const dx = ox - c.x;
      const dy = oy - c.y;
      // Circular footprint with a soft, ragged edge.
      if (dx * dx + dy * dy > c.r * c.r * (0.55 + st.next() * 0.45)) continue;

      // Buildings sit on a lattice inside the block with a street gap around
      // it, so the grain of streets reads from directly above instead of
      // looking like scattered confetti.
      const per = st.int(2, 4);
      const cols = per > 2 ? 2 : 1;
      for (let k = 0; k < per; k++) {
        const col = k % cols;
        const row = Math.floor(k / cols);
        const w = (step * 0.62) / cols - 1.5;
        const h = step * 0.62 * (cols === 2 ? 0.5 : 0.34);
        out.push({
          x: ox + (col - (cols - 1) / 2) * (step * 0.34) + st.range(-1.5, 1.5),
          y: oy + (row - 0.5) * (step * 0.34) + st.range(-1.5, 1.5),
          w,
          h,
          dmg: 0,
          // Taller kinds cluster toward the centre - downtown reads from above.
          kind: st.next() < 1 - Math.sqrt(dx * dx + dy * dy) / c.r ? st.int(3, 6) : st.int(0, 3),
        });
      }
    }
  }
  c.buildings = out;
}

/** Detail-sim the 6 nearest cities to the player; drop the rest to a disc. */
export function updateCityDetail(w: WorldState): void {
  const p = w.storms[w.playerId];
  if (p === undefined) return;
  const near: { i: number; d: number }[] = [];
  for (let i = 0; i < w.cities.length; i++) {
    const c = w.cities[i];
    near.push({ i, d: wrapDist2(p.x, p.y, c.x, c.y) });
  }
  near.sort((a, b) => a.d - b.d);
  for (let k = 0; k < near.length; k++) {
    const c = w.cities[near[k].i];
    if (k < CAP_DETAIL_CITIES) detailCity(c);
    else if (c.detailed && c.reserve >= c.reserveMax) {
      c.detailed = false;
      c.buildings.length = 0;
    }
  }
}

/** Index of the city whose footprint contains this point, or -1. */
export function cityAt(w: WorldState, x: number, y: number): number {
  for (let i = 0; i < w.cities.length; i++) {
    const c = w.cities[i];
    if (wrapDist2(x, y, c.x, c.y) < c.r * c.r) return i;
  }
  return -1;
}

/**
 * Runs the drain for one storm. Returns the mass gained this step.
 * The caller owns the -35% speed penalty.
 */
export function drainCity(
  w: WorldState,
  cityIndex: number,
  stormId: number,
  dt: number,
  events: SimEvent[],
): number {
  const c = w.cities[cityIndex];
  if (c.reserve <= 0) return 0;

  const take = Math.min(c.reserve, CITY_DRAIN_RATE * dt);
  c.reserve -= take;

  // Buildings flatten as the reserve goes.
  const frac = 1 - c.reserve / c.reserveMax;
  const wantFlat = Math.floor(frac * c.buildings.length);
  for (let i = 0; i < c.buildings.length; i++) {
    const b = c.buildings[i];
    if (i < wantFlat && b.dmg < 1) {
      b.dmg = Math.min(1, b.dmg + dt * 2.2);
      if (b.dmg >= 1) {
        events.push({ type: 'buildingCollapse', storm: stormId, x: b.x, y: b.y, a: b.w, b: b.h });
      }
    }
  }

  if (c.reserve <= 0) {
    c.reserve = 0;
    c.rebuild = CITY_REBUILD_TIME;
    c.emptiedBy = stormId;
    events.push({ type: 'cityEmptied', storm: stormId, x: c.x, y: c.y, a: c.tier, b: cityIndex });
  }

  return CITY_FEED_MPS * dt;
}

/** Rebuilds play in reverse over 90s. */
export function updateCities(w: WorldState, dt: number): void {
  for (let i = 0; i < w.cities.length; i++) {
    const c = w.cities[i];
    if (c.rebuild <= 0) continue;
    c.rebuild -= dt;
    const t = 1 - c.rebuild / CITY_REBUILD_TIME;
    c.reserve = c.reserveMax * Math.min(1, t);
    const standing = Math.floor((1 - t) * c.buildings.length);
    for (let b = 0; b < c.buildings.length; b++) {
      c.buildings[b].dmg = b < standing ? 1 : 0;
    }
    if (c.rebuild <= 0) {
      c.rebuild = 0;
      c.reserve = c.reserveMax;
      c.emptiedBy = -1;
      for (let b = 0; b < c.buildings.length; b++) c.buildings[b].dmg = 0;
    }
  }
}
