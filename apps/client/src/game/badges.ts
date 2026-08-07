/**
 * Badges. Unlocked in-run, persisted to localStorage, shown on game-over and
 * in a gallery.
 *
 * The tracker lives outside /src/sim on purpose: the simulation stays lean and
 * server-ready, and everything here is derived from published SimEvents plus
 * read-only state. Nothing in this file can change the outcome of a run.
 */

import {
  RANK_EL_NINO,
  WARM_SST,
  WORLD_W,
  fieldRadius,
  latToY,
  lonToX,
  wrapDeltaX,
  wrapDist,
} from '@sen/sim/sim/constants.ts';
import type { SimEvent, WorldState } from '@sen/sim/sim/types.ts';
import { sampleTerrain, sstAt } from '@sen/sim/sim/terrain.ts';

export type BadgeId =
  // Progression
  | 'touchdown' | 'landfall' | 'namedStorm' | 'basinWide' | 'superElNino' | 'perfectStorm'
  // Ocean
  | 'warmPool' | 'crossing' | 'blueWater' | 'boilingPoint' | 'armada' | 'laNina'
  // Feeding
  | 'cattleDrive' | 'deforestation' | 'metropolis' | 'grandTour' | 'rushHour' | 'stormChaser'
  // Combat
  | 'firstBlood' | 'stormHunter' | 'apex' | 'cleanKill' | 'ambush' | 'untouchable'
  // Geography
  | 'circumnavigate' | 'coriolis' | 'polarExpress' | 'greenlandIsHuge' | 'homecoming'
  // Style
  | 'threadingTheNeedle' | 'comeback' | 'speedrun' | 'pacifist'
  // Meta
  | 'runs10' | 'runs50' | 'runs200' | 'installPwa' | 'shareClip' | 'allBadges';

export interface BadgeDef {
  id: BadgeId;
  group: 'progression' | 'ocean' | 'feeding' | 'combat' | 'geography' | 'style' | 'meta';
  /** Hidden until earned. */
  secret?: boolean;
  /** Meta badges are awarded outside a run. */
  meta?: boolean;
}

export const BADGES: BadgeDef[] = [
  { id: 'touchdown', group: 'progression' },
  { id: 'landfall', group: 'progression' },
  { id: 'namedStorm', group: 'progression' },
  { id: 'basinWide', group: 'progression' },
  { id: 'superElNino', group: 'progression' },
  { id: 'perfectStorm', group: 'progression', secret: true },

  { id: 'warmPool', group: 'ocean' },
  { id: 'crossing', group: 'ocean' },
  { id: 'blueWater', group: 'ocean' },
  { id: 'boilingPoint', group: 'ocean', secret: true },
  { id: 'armada', group: 'ocean' },
  { id: 'laNina', group: 'ocean', secret: true },

  { id: 'cattleDrive', group: 'feeding' },
  { id: 'deforestation', group: 'feeding' },
  { id: 'metropolis', group: 'feeding' },
  { id: 'grandTour', group: 'feeding' },
  { id: 'rushHour', group: 'feeding' },
  { id: 'stormChaser', group: 'feeding', secret: true },

  { id: 'firstBlood', group: 'combat' },
  { id: 'stormHunter', group: 'combat' },
  { id: 'apex', group: 'combat' },
  { id: 'cleanKill', group: 'combat', secret: true },
  { id: 'ambush', group: 'combat', secret: true },
  { id: 'untouchable', group: 'combat' },

  { id: 'circumnavigate', group: 'geography' },
  { id: 'coriolis', group: 'geography' },
  { id: 'polarExpress', group: 'geography' },
  { id: 'greenlandIsHuge', group: 'geography', secret: true },
  { id: 'homecoming', group: 'geography', secret: true },

  { id: 'threadingTheNeedle', group: 'style', secret: true },
  { id: 'comeback', group: 'style' },
  { id: 'speedrun', group: 'style' },
  { id: 'pacifist', group: 'style' },

  { id: 'runs10', group: 'meta', meta: true },
  { id: 'runs50', group: 'meta', meta: true },
  { id: 'runs200', group: 'meta', meta: true },
  { id: 'installPwa', group: 'meta', meta: true },
  { id: 'shareClip', group: 'meta', meta: true },
  { id: 'allBadges', group: 'meta', meta: true, secret: true },
];

export const BADGE_IDS = BADGES.map((b) => b.id);

// Greece, for Homecoming. Note this box straddles the wrap seam (the map's
// x=0 is 20 degrees east), so it is stored as centre + half-width and every
// test goes through wrapDeltaX.
const GR_CX = lonToX(24.5);
const GR_HALF_W = ((29.7 - 19.3) / 360) * WORLD_W * 0.5;
const GR_Y0 = latToY(41.8);
const GR_Y1 = latToY(34.6);

/**
 * Watches one run and reports newly earned badges. Fed events + state each
 * frame; never writes to either.
 */
export class RunTracker {
  private earned = new Set<BadgeId>();
  private pending: BadgeId[] = [];

  private seaRun = 0;
  private seaStartX = 0;
  private seaCrossed = false;
  private droppedLow = false;
  private boostedAt = -99;
  private greece = false;

  reset(): void {
    this.earned.clear();
    this.pending.length = 0;
    this.seaRun = 0;
    this.seaCrossed = false;
    this.droppedLow = false;
    this.boostedAt = -99;
    this.greece = false;
  }

  private award(id: BadgeId): void {
    if (this.earned.has(id)) return;
    this.earned.add(id);
    this.pending.push(id);
  }

  /** Drains the queue of badges earned since the last call. */
  drain(): BadgeId[] {
    if (this.pending.length === 0) return [];
    const out = this.pending.slice();
    this.pending.length = 0;
    return out;
  }

  has(id: BadgeId): boolean {
    return this.earned.has(id);
  }

  /** Seed already-unlocked badges so a toast never fires twice for one player. */
  preload(ids: BadgeId[]): void {
    for (const id of ids) this.earned.add(id);
  }

  update(w: WorldState, dt: number): void {
    const p = w.storms[w.playerId];
    if (p === undefined || !p.alive) return;
    const st = p.stats;
    const rank = p.rank;

    // --- progression -------------------------------------------------------
    if (rank >= 2) this.award('touchdown');
    if (rank >= 3) this.award('landfall');
    if (rank >= 4) this.award('namedStorm');
    if (rank >= RANK_EL_NINO) this.award('basinWide');
    if (w.winner === p.id) {
      this.award('superElNino');
      if (st.shredsTaken === 0) this.award('perfectStorm');
    }

    // --- ocean --------------------------------------------------------------
    const here = sampleTerrain(w.terrain, p.x, p.y);
    if (here.water) {
      if (this.seaRun === 0) this.seaStartX = p.x;
      this.seaRun += dt;
      if (this.seaRun >= 60) this.award('blueWater');
      // Crossing: swim ocean to ocean at Cyclone or better. A quarter of the
      // planet's circumference without touching land is unambiguous.
      if (rank >= 3 && Math.abs(wrapDeltaX(this.seaStartX, p.x)) > WORLD_W * 0.25) {
        this.seaCrossed = true;
      }
    } else {
      this.seaRun = 0;
    }
    if (this.seaCrossed) this.award('crossing');
    if (st.maxHeatCell >= 254) this.award('boilingPoint');
    if (st.ships >= 20) this.award('armada');

    // --- feeding ------------------------------------------------------------
    if (st.cows >= 100) this.award('cattleDrive');
    if (st.trees >= 500) this.award('deforestation');
    if (st.t1Emptied >= 1) this.award('metropolis');
    if (popcount(st.continents) >= 4) this.award('grandTour');
    if (st.carsIn10s >= 50) this.award('rushHour');
    if (st.chaserCaught >= 1) this.award('stormChaser');

    // --- combat -------------------------------------------------------------
    if (st.shredsDealt >= 1) this.award('firstBlood');
    if (st.shredsDealt >= 5) this.award('stormHunter');
    if (st.aliveTime >= 300 && st.shredsTaken === 0) this.award('untouchable');

    // --- geography ----------------------------------------------------------
    if (Math.abs(st.distanceX) >= WORLD_W) this.award('circumnavigate');
    if (st.equatorCrossings >= 10) this.award('coriolis');
    if (st.touchedNorthCap && st.touchedSouthCap) this.award('polarExpress');
    if (st.greenlandTime >= 60) this.award('greenlandIsHuge');

    if (!this.greece && !here.water) {
      const inGreece =
        p.y > GR_Y0 && p.y < GR_Y1 && Math.abs(wrapDeltaX(GR_CX, p.x)) < GR_HALF_W;
      if (inGreece) {
        this.greece = true;
        this.award('homecoming');
      }
    }

    // --- style ---------------------------------------------------------------
    if (p.boosting) this.boostedAt = st.aliveTime;
    if (p.mass < 10) this.droppedLow = true;
    if (this.droppedLow && rank >= 5) this.award('comeback');
    if (st.timeToElNino >= 0 && st.timeToElNino < 240) this.award('speedrun');
    if (rank >= 5 && st.shredsDealt === 0) this.award('pacifist');

    // Threading the Needle: pass between two rival fields, both within 100
    // units of your eye, and survive it.
    if (p.invuln <= 0) {
      let close = 0;
      for (let i = 0; i < w.storms.length; i++) {
        const o = w.storms[i];
        if (o === p || !o.alive) continue;
        const d = wrapDist(p.x, p.y, o.x, o.y);
        if (d - fieldRadius(o.mass) < 100) close++;
      }
      if (close >= 2) this.award('threadingTheNeedle');
    }
  }

  /** Event-driven badges that need the moment, not the aggregate. */
  onEvent(w: WorldState, e: SimEvent): void {
    const p = w.storms[w.playerId];
    if (p === undefined) return;

    if (e.type === 'shred' && e.a === p.id) {
      const victim = w.storms[e.storm];
      if (victim !== undefined) {
        // e.b is the victim's mass *after* the 30% shred.
        const before = victim.mass > 0 ? e.b / 0.7 : 0;
        if (before > p.mass) this.award('apex');
        if (victim.isLaNina) this.award('laNina');
        if (victim.drainingCity >= 0) this.award('ambush');
      }
      if (p.stats.aliveTime - this.boostedAt > 3) this.award('cleanKill');
    }

    if (e.type === 'cityEmptied' && e.storm === p.id) {
      p.stats.citiesEmptied++;
      if (e.a === 1) p.stats.t1Emptied++;
    }

    if (e.type === 'absorb' && e.storm === p.id) {
      const t = sampleTerrain(w.terrain, e.x, e.y);
      if (t.water && sstAt(w, e.x, e.y) >= WARM_SST) this.award('warmPool');
    }
  }
}

export function popcount(n: number): number {
  let c = 0;
  let v = n;
  while (v !== 0) {
    v &= v - 1;
    c++;
  }
  return c;
}

