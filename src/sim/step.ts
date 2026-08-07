/**
 * The simulation step.
 *
 * step() is a pure, headless, deterministic function of (state, inputs).
 * dt is fixed at 1/60 - never feed variable dt in here. Accumulate real time
 * outside, run fixed steps, render with interpolation.
 *
 * Nothing in this file may touch PixiJS, howler, window or document.
 */

import {
  CAP_STICKMEN,
  CHASER_MASS_MUL,
  FAR_SIM_DIST,
  FAR_SIM_HZ,
  FIXED_DT,
  LA_NINA_FEED,
  MIN_MASS,
  RANK_EL_NINO,
  RANK_SUPER,
  SST_HZ,
  STICKMAN_ALERT_RANGE,
  STICKMAN_FLEE_SPEED,
  STICKMAN_MASS,
  WIN_HOLD_TIME,
  WORLD_H,
  WORLD_W,
  clamp,
  coreRadius,
  eyeRadius,
  rankOf,
  suctionRadius,
  warmPoolT,
  wrapDeltaX,
  wrapX,
} from './constants.ts';
import { cityAt, drainCity, updateCities, updateCityDetail } from './cities.ts';
import { streamChunks } from './chunks.ts';
import { PROP_KINDS } from './props.ts';
import { rand } from './rng.ts';
import { clearHash, insert, query } from './spatial.ts';
import {
  addFieldItem,
  applyInput,
  eyeCollide,
  moveStorm,
  tickStormTimers,
  tryShred,
  updateBoost,
} from './storm.ts';
import { continentOf, decaySst, heatSst, sampleTerrain, sstAt, terrainEffect } from './terrain.ts';
import { ManState } from './types.ts';
import type { Chunk, Input, Storm, WorldState } from './types.ts';
import { designateLaNina, respawnBot } from './world.ts';

// Per-frame scratch. Zero allocation in the hot loop.
const chunkList: Chunk[] = [];
const found: number[] = [];

const KIND_DEBRIS = 0;
const KIND_MAN = 1;
const KIND_PROP = 2;
const PROP_STRIDE = 4096;
const CLS_AIR = 6;

// ---------------------------------------------------------------------------
// Loose debris pool
// ---------------------------------------------------------------------------

export function spawnDebris(
  w: WorldState,
  x: number,
  y: number,
  vx: number,
  vy: number,
  mass: number,
  type: number,
  cls: number,
): void {
  const n = w.debris.length;
  for (let k = 0; k < n; k++) {
    const i = (w.debrisCursor + k) % n;
    const d = w.debris[i];
    if (d.active) continue;
    w.debrisCursor = (i + 1) % n;
    d.x = wrapX(x);
    d.y = clamp(y, 0, WORLD_H);
    d.vx = vx;
    d.vy = vy;
    d.mass = mass;
    d.type = type;
    d.cls = cls;
    d.life = 0;
    d.active = true;
    return;
  }
}

function updateDebris(w: WorldState, dt: number): void {
  for (let i = 0; i < w.debris.length; i++) {
    const d = w.debris[i];
    if (!d.active) continue;
    d.x = wrapX(d.x + d.vx * dt);
    d.y = clamp(d.y + d.vy * dt, 0, WORLD_H);
    // Air drag: scattered debris spreads then settles.
    const drag = Math.exp(-2.4 * dt);
    d.vx *= drag;
    d.vy *= drag;
    d.life += dt;
  }
}

// ---------------------------------------------------------------------------
// Spatial hash build
// ---------------------------------------------------------------------------

function buildHash(w: WorldState): void {
  const h = w._hash;
  clearHash(h);

  for (let i = 0; i < w.debris.length; i++) {
    const d = w.debris[i];
    if (d.active) insert(h, d.x, d.y, KIND_DEBRIS, i);
  }
  for (let i = 0; i < w.stickmen.length; i++) {
    const m = w.stickmen[i];
    if (m.active) insert(h, m.x, m.y, KIND_MAN, i);
  }

  chunkList.length = 0;
  for (const c of w.chunks.values()) chunkList.push(c);
  for (let ci = 0; ci < chunkList.length; ci++) {
    const props = chunkList[ci].props;
    for (let p = 0; p < props.length; p++) {
      if (props[p].alive) insert(h, props[p].x, props[p].y, KIND_PROP, ci * PROP_STRIDE + p);
    }
  }
}

// ---------------------------------------------------------------------------
// Stickmen
// ---------------------------------------------------------------------------

const nearbyStorms: Storm[] = [];

/**
 * Stickmen only exist within MAN_RANGE of the player, so the only storms that
 * can ever matter to one are the storms near the player. Collecting them once
 * a frame turns a 400 x 65 scan into 400 x 3.
 */
function collectNearbyStorms(w: WorldState): void {
  nearbyStorms.length = 0;
  const p = w.storms[w.playerId];
  if (p === undefined) return;
  const reach = 4200;
  for (let i = 0; i < w.storms.length; i++) {
    const s = w.storms[i];
    if (!s.alive) continue;
    const dx = wrapDeltaX(p.x, s.x);
    const dy = s.y - p.y;
    if (dx * dx + dy * dy < reach * reach) nearbyStorms.push(s);
  }
}

function updateStickmen(w: WorldState, dt: number): void {
  const storms = nearbyStorms;
  for (let i = 0; i < w.stickmen.length; i++) {
    const m = w.stickmen[i];
    if (!m.active) continue;

    // Nearest live storm.
    let nd2 = Infinity;
    let near: Storm | null = null;
    for (let s = 0; s < storms.length; s++) {
      const st = storms[s];
      if (!st.alive) continue;
      const dx = wrapDeltaX(m.x, st.x);
      const dy = st.y - m.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nd2) {
        nd2 = d2;
        near = st;
      }
    }

    m.ph += dt * 3.2;

    if (near === null) {
      m.state = ManState.Idle;
    } else {
      const d = Math.sqrt(nd2);
      const suck = suctionRadius(near.mass);
      if (d < suck) m.state = ManState.Caught;
      else if (d < STICKMAN_ALERT_RANGE * 0.62) m.state = ManState.Flee;
      else if (d < STICKMAN_ALERT_RANGE) m.state = ManState.Alert;
      else m.state = ManState.Idle;

      const dx = wrapDeltaX(m.x, near.x);
      const dy = near.y - m.y;
      const inv = d > 0.001 ? 1 / d : 0;

      if (m.state === ManState.Flee) {
        // The chaser runs toward you holding a camera. Everyone else runs.
        const sign = m.chaser ? 1 : -1;
        // Panic wobble.
        const wob = Math.sin(m.ph * 2.1) * 0.5;
        const ax = dx * inv * sign;
        const ay = dy * inv * sign;
        m.vx = (ax - ay * wob) * STICKMAN_FLEE_SPEED;
        m.vy = (ay + ax * wob) * STICKMAN_FLEE_SPEED;
      } else if (m.state === ManState.Caught) {
        // Dragged in on a spiral, limbs flailing faster as they close.
        const pull = 220 + (1 - d / suck) * 520;
        const tang = near.spinDir * 1.35;
        m.vx = (dx * inv + -dy * inv * tang) * pull;
        m.vy = (dy * inv + dx * inv * tang) * pull;
      } else if (m.state === ManState.Alert) {
        m.vx = 0;
        m.vy = 0;
      } else {
        // Idle wander, phase-driven so it costs no RNG.
        const a = m.ph * 0.21 + i * 1.7;
        m.vx = Math.cos(a) * 16;
        m.vy = Math.sin(a * 1.3) * 16;
      }
    }

    const nx = wrapX(m.x + m.vx * dt);
    const ny = clamp(m.y + m.vy * dt, 0, WORLD_H);

    if (m.state === ManState.Caught) {
      // Already airborne and spiralling in - the sea is not their problem now.
      m.x = nx;
      m.y = ny;
      continue;
    }

    // People run on land. A panicking crowd will otherwise sprint straight off
    // a headland and jog around on open water. Try the full move, then each
    // axis alone, so they slide along a coastline instead of sticking to it.
    if (!blocked(w, nx, ny)) {
      m.x = nx;
      m.y = ny;
    } else if (!blocked(w, nx, m.y)) {
      m.x = nx;
      m.vy = 0;
    } else if (!blocked(w, m.x, ny)) {
      m.y = ny;
      m.vx = 0;
    } else {
      m.vx = 0;
      m.vy = 0;
    }
  }
}

/** Sea and ice are both off-limits on foot. */
function blocked(w: WorldState, x: number, y: number): boolean {
  const t = sampleTerrain(w.terrain, x, y);
  return t.water || t.ice;
}

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------

/**
 * Ships and aircraft move. A sea full of parked container ships reads as
 * scenery; a sea with traffic in it reads as a world, and the late game is
 * mostly spent out there.
 */
function updateTraffic(w: WorldState, dt: number): void {
  for (const chunk of w.chunks.values()) {
    const props = chunk.props;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!p.alive || p.spd === 0) continue;

      const nx = wrapX(p.x + Math.cos(p.ang) * p.spd * dt);
      const ny = p.y + Math.sin(p.ang) * p.spd * dt;

      if (p.cls === CLS_AIR) {
        // Aircraft overfly everything; they only turn at the ice caps.
        p.x = nx;
        p.y = clamp(ny, 60, WORLD_H - 60);
        if (p.y <= 60 || p.y >= WORLD_H - 60) p.ang = -p.ang;
        continue;
      }

      // Ships stay at sea: bounce off any coast they run into.
      if (ny < 40 || ny > WORLD_H - 40 || !sampleTerrain(w.terrain, nx, ny).water) {
        p.ang += 2.1;
        continue;
      }
      p.x = nx;
      p.y = ny;
    }
  }
}

// ---------------------------------------------------------------------------
// Absorption
// ---------------------------------------------------------------------------

function creditProp(s: Storm, cls: number): void {
  if (cls === 1) s.stats.trees++;
  else if (cls === 2) s.stats.cows++;
  else if (cls === 3) s.stats.cars++;
  else if (cls === 4) s.stats.ships++;
}

function absorbFor(w: WorldState, s: Storm, dt: number): number {
  const h = w._hash;
  const suck = suctionRadius(s.mass);
  const core = coreRadius(s.mass);
  const eat = core * 0.62;
  let gained = 0;

  query(h, s.x, s.y, suck, found);
  for (let k = 0; k < found.length; k++) {
    const idx = found[k];
    const kind = h.kind[idx];
    const ref = h.ref[idx];
    const dx = wrapDeltaX(s.x, h.ix[idx]);
    const dy = h.iy[idx] - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > suck * suck) continue;
    const d = Math.sqrt(d2);

    if (kind === KIND_PROP) {
      const ci = (ref / PROP_STRIDE) | 0;
      const pi = ref - ci * PROP_STRIDE;
      const chunk = chunkList[ci];
      if (chunk === undefined) continue;
      const p = chunk.props[pi];
      if (p === undefined || !p.alive) continue;
      p.alive = false;
      // Props lift off into loose debris, then get sucked in - the catch
      // reads as physics rather than a despawn.
      const inv = d > 0.001 ? 1 / d : 0;
      const tang = s.spinDir * 0.9;
      spawnDebris(
        w,
        p.x,
        p.y,
        (dx * inv * 0.4 + -dy * inv * tang) * 90,
        (dy * inv * 0.4 + dx * inv * tang) * 90,
        p.mass,
        PROP_KINDS[p.type].debris,
        p.cls,
      );
      creditProp(s, p.cls);
      if (p.cls === 3) s.stats.carWindow.push(w.time);
      continue;
    }

    if (kind === KIND_MAN) {
      const m = w.stickmen[ref];
      if (!m.active) continue;
      if (d < eat) {
        const gain = STICKMAN_MASS * (m.chaser ? CHASER_MASS_MUL : 1);
        s.mass += gain;
        gained += gain;
        s.stats.stickmen++;
        m.active = false;
        addFieldItem(w, s, m.chaser ? 1 : 0, 1, m.x, m.y);
        w.events.push({ type: 'absorb', storm: s.id, x: m.x, y: m.y, a: gain, b: 1 });
        if (m.chaser) {
          s.stats.chaserCaught++;
          w.events.push({ type: 'chaser', storm: s.id, x: m.x, y: m.y, a: 0, b: 0 });
        }
      }
      continue;
    }

    const dbg = w.debris[ref];
    if (!dbg.active) continue;
    if (d < eat) {
      s.mass += dbg.mass;
      gained += dbg.mass;
      dbg.active = false;
      addFieldItem(w, s, dbg.type, dbg.cls, dbg.x, dbg.y);
      w.events.push({ type: 'absorb', storm: s.id, x: dbg.x, y: dbg.y, a: dbg.mass, b: 0 });
    } else {
      // Accelerate toward the eye, with a tangential component so debris
      // corkscrews in instead of falling straight down the drain.
      const inv = 1 / Math.max(0.001, d);
      const pull = 620 * (1 - d / suck) + 180;
      const tang = s.spinDir * 1.1;
      dbg.vx += (dx * inv + -dy * inv * tang) * pull * dt;
      dbg.vy += (dy * inv + dx * inv * tang) * pull * dt;
    }
  }
  return gained;
}

// ---------------------------------------------------------------------------
// Dissipation
// ---------------------------------------------------------------------------

function dissipate(w: WorldState, s: Storm): void {
  s.alive = false;
  // Your whole mass scatters as loose debris in a ring - the biggest feeding
  // opportunity in the game.
  const n = Math.min(46, Math.max(8, Math.floor(s.mass / 6)));
  const each = s.mass / n;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(w) * 0.3;
    const r = coreRadius(s.mass) * (0.6 + rand(w) * 1.4);
    const sp = 90 + rand(w) * 220;
    const src = s.field.length > 0 ? s.field[i % s.field.length] : null;
    spawnDebris(
      w,
      s.x + Math.cos(a) * r,
      s.y + Math.sin(a) * r,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      each,
      src ? src.type : 5,
      src ? src.cls : 0,
    );
  }
  s.field.length = 0;
  s.mass = 0;
  s.drainingCity = -1;
  s.winTimer = 0;
  w.events.push({ type: 'dissipate', storm: s.id, x: s.x, y: s.y, a: 0, b: 0 });
}

// ---------------------------------------------------------------------------
// One storm's update
// ---------------------------------------------------------------------------

function stepStorm(w: WorldState, s: Storm, input: Input, dt: number): void {
  applyInput(w, s, input, dt);

  const rank = rankOf(s.mass);
  const eff = terrainEffect(w, s.x, s.y, rank);

  // Cities: the big feed, and the moment you are most killable.
  let speedMul = eff.speedMul;
  const ci = cityAt(w, s.x, s.y);
  const wasDraining = s.drainingCity;
  if (ci >= 0 && w.cities[ci].reserve > 0 && !eff.water) {
    if (wasDraining !== ci) {
      w.events.push({ type: 'cityDrainStart', storm: s.id, x: s.x, y: s.y, a: ci, b: w.cities[ci].tier });
    }
    s.drainingCity = ci;
    s.mass += drainCity(w, ci, s.id, dt, w.events);
    speedMul = Math.min(speedMul, 0.65);
  } else {
    if (wasDraining >= 0) {
      w.events.push({ type: 'cityDrainStop', storm: s.id, x: s.x, y: s.y, a: wasDraining, b: 0 });
    }
    s.drainingCity = -1;
  }

  moveStorm(s, speedMul, dt);
  updateBoost(w, s, dt, spawnDebris);

  // La Nina eats better than anyone else. This is what keeps her the largest
  // bot in the run without renaming rivals mid-flight - the title stays with
  // one storm, and the edge is what makes it true.
  const feedMul = s.isLaNina ? LA_NINA_FEED : 1;

  // Terrain mass channel. This table is the whole mid-game.
  s.mass += eff.massPerSec * (eff.massPerSec > 0 ? feedMul : 1) * dt;
  if (eff.water) s.stats.seaTime += dt;

  const gained = absorbFor(w, s, dt) * feedMul;
  if (feedMul !== 1) s.mass += gained - gained / feedMul;

  // Warm water heats further as you feed in it - a visible red bloom that
  // every other player and bot can see from across the world. You cannot win
  // quietly.
  if (eff.water && (gained > 0 || eff.massPerSec > 0)) {
    const heat = gained * 0.5 + Math.max(0, eff.massPerSec) * dt * 3.2;
    const now = heatSst(w, s.x, s.y, heat);
    if (now > s.stats.maxHeatCell) s.stats.maxHeatCell = now;
  }

  if (!eff.water && !eff.ice && gained > 0) {
    s.stats.continents |= 1 << continentOf(s.x, s.y);
  }

  // Ice caps and Greenland, for the geography badges.
  if (s.y < WORLD_H * 0.09) s.stats.touchedNorthCap = true;
  if (s.y > WORLD_H * 0.91) s.stats.touchedSouthCap = true;
  if (isGreenland(w, s.x, s.y)) s.stats.greenlandTime += dt;
  else s.stats.greenlandTime = 0;

  // Rush Hour: 50 cars in 10 seconds.
  const win = s.stats.carWindow;
  while (win.length > 0 && w.time - win[0] > 10) win.shift();
  if (win.length > s.stats.carsIn10s) s.stats.carsIn10s = win.length;

  // Win condition: reach El Nino rank, then hold the equatorial Pacific warm
  // pool for 60 seconds without being shredded.
  const newRank = rankOf(s.mass);
  if (newRank >= RANK_EL_NINO && warmPoolT(s.x, s.y) <= 1) {
    s.winTimer += dt;
    if (s.winTimer >= WIN_HOLD_TIME && w.winner < 0) {
      s.mass = Math.max(s.mass, 5000);
      w.winner = s.id;
      w.events.push({ type: 'win', storm: s.id, x: s.x, y: s.y, a: 0, b: 0 });
      if (s.id === w.playerId) w.over = true;
    }
  } else if (s.winTimer > 0) {
    s.winTimer = 0;
  }

  const finalRank = rankOf(s.mass);
  if (finalRank !== s.rank) {
    if (finalRank > s.rank) {
      w.events.push({ type: 'rankUp', storm: s.id, x: s.x, y: s.y, a: finalRank, b: s.rank });
      if (finalRank >= RANK_EL_NINO && s.stats.timeToElNino < 0) {
        s.stats.timeToElNino = s.stats.aliveTime;
      }
    }
    s.rank = finalRank;
  }

  tickStormTimers(s, dt);

  if (s.mass < MIN_MASS && s.rank < RANK_SUPER) dissipate(w, s);
}

/** Greenland is a Mercator superpower. That's funny - keep it, badge it. */
function isGreenland(w: WorldState, x: number, y: number): boolean {
  if (y > WORLD_H * 0.2 || y < WORLD_H * 0.03) return false;
  const t = sampleTerrain(w.terrain, x, y);
  if (t.water) return false;
  // Greenland sits between Canada and Iceland in world-x on this projection.
  const tx = x / WORLD_W;
  return tx > 0.775 && tx < 0.885;
}

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

function resolveCollisions(w: WorldState): void {
  const storms = w.storms;
  for (let i = 0; i < storms.length; i++) {
    const a = storms[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < storms.length; j++) {
      const b = storms[j];
      if (!b.alive) continue;

      const dx = wrapDeltaX(a.x, b.x);
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;

      // Eye vs eye first: no instant kill, the larger absorbs 40%.
      const eyeSum = eyeRadius(a.mass) + eyeRadius(b.mass);
      if (d2 < eyeSum * eyeSum) {
        eyeCollide(w, a, b);
        continue;
      }

      // Then eye vs field, both ways. A small storm can knife through the gaps
      // in a big one's rings; a big one telegraphs everything.
      tryShred(w, a, b);
      tryShred(w, b, a);
    }
  }
}

// ---------------------------------------------------------------------------
// step()
// ---------------------------------------------------------------------------

const NEUTRAL: Input = { steerAngle: 0, boosting: false };

/**
 * Advance the world by exactly one fixed tick.
 *
 * @param inputs one Input per storm id. Missing ids coast on their heading.
 */
export function step(w: WorldState, inputs: Map<number, Input>): void {
  const dt = FIXED_DT;
  w.events.length = 0;
  w.tick++;
  w.time += dt;

  streamChunks(w);
  updateCityDetail(w);
  buildHash(w);
  collectNearbyStorms(w);
  updateStickmen(w, dt);

  const player = w.storms[w.playerId];

  for (let i = 0; i < w.storms.length; i++) {
    const s = w.storms[i];

    if (!s.alive) {
      if (s.kind === 'bot') {
        s.botTimer -= dt;
        if (s.botTimer <= 0) {
          respawnBot(w, s);
          designateLaNina(w);
        }
      }
      continue;
    }

    let input = inputs.get(s.id);
    if (input === undefined) {
      input = NEUTRAL;
      input.steerAngle = s.ang;
      input.boosting = false;
    }

    // Distant storms sim at 20Hz with simplified fields.
    if (s.kind === 'bot' && player !== undefined) {
      const dx = wrapDeltaX(s.x, player.x);
      const dy = player.y - s.y;
      if (dx * dx + dy * dy > FAR_SIM_DIST * FAR_SIM_DIST) {
        s.farAccum += dt;
        const stepDt = 1 / FAR_SIM_HZ;
        if (s.farAccum < stepDt) continue;
        const use = s.farAccum;
        s.farAccum = 0;
        stepStorm(w, s, input, use);
        continue;
      }
      s.farAccum = 0;
    }

    stepStorm(w, s, input, dt);
    if (!s.alive) {
      if (s.kind === 'bot') s.botTimer = 3 + rand(w) * 4;
      else if (s.id === w.playerId) w.over = true;
    }
  }

  updateDebris(w, dt);
  updateTraffic(w, dt);
  resolveCollisions(w);
  updateCities(w, dt);

  // The sea-temp overlay updates at 10Hz, not per frame.
  w.sstAccum += dt;
  const sstStep = 1 / SST_HZ;
  while (w.sstAccum >= sstStep) {
    w.sstAccum -= sstStep;
    decaySst(w, sstStep);
  }

  // Keep the stickman pool inside its cap.
  if (w.stickmen.length > CAP_STICKMEN) {
    for (let i = CAP_STICKMEN; i < w.stickmen.length; i++) w.stickmen[i].active = false;
    w.stickmen.length = CAP_STICKMEN;
  }
}

/** Read-only helper used by HUD, minimap and bots. */
export function warmthAt(w: WorldState, x: number, y: number): number {
  return sstAt(w, x, y);
}
