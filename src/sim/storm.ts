/**
 * Storm mechanics: movement, the debris field, absorption and shredding.
 *
 * The debris field is the one mechanic everything hangs off. It is a weapon:
 * fly your eye into someone else's field and you get shredded. Bigger is not
 * strictly better - a huge storm has a wide, slow-turning, heavily telegraphed
 * field, a small one is nimble and can knife through gaps. That asymmetry is
 * the skill ceiling. Protect it in balancing.
 */

import {
  BOOST_DRAIN,
  BOOST_EJECT_INTERVAL,
  BOOST_MIN_MASS,
  BOOST_SPEED_MUL,
  BOOST_TURN_MUL,
  CAP_FIELD_ITEMS,
  CORIOLIS_FLIP_TIME,
  CORIOLIS_TURN_BONUS,
  EQUATOR_Y,
  EYE_ABSORB,
  EYE_THROW,
  MIN_MASS,
  SHRED_INVULN,
  SHRED_KNOCKBACK,
  SHRED_MASS_LOSS,
  WORLD_H,
  angleDelta,
  clamp,
  eyeRadius,
  fieldRadius,
  maxTurnRate,
  rankOf,
  stormSpeed,
  wrapDeltaX,
  wrapX,
} from './constants.ts';
import { rand } from './rng.ts';
import type { FieldItem, Input, Storm, WorldState } from './types.ts';

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

/** Base angular speed of the field, radians/sec. Big storms wheel slower. */
export function fieldSpin(mass: number): number {
  return 2.4 - 1.35 * Math.min(1, Math.log(mass / 10) / Math.log(500));
}

export function addFieldItem(
  w: WorldState,
  s: Storm,
  type: number,
  cls: number,
  fromX: number,
  fromY: number,
): void {
  if (s.field.length >= CAP_FIELD_ITEMS) {
    // Field is full: recycle the oldest slot so the newest catch is visible.
    const victim = s.field[Math.floor(rand(w) * s.field.length)];
    victim.type = type;
    victim.cls = cls;
    victim.t = 0;
    victim.sx = wrapDeltaX(s.x, fromX);
    victim.sy = fromY - s.y;
    return;
  }
  s.field.push({
    ang: rand(w) * Math.PI * 2,
    // 3-4 stacked rings at different radii.
    rt: 0.42 + Math.floor(rand(w) * 4) * 0.19 + rand(w) * 0.06,
    spin: 0.75 + rand(w) * 0.55,
    wob: rand(w) * Math.PI * 2,
    type,
    cls,
    t: 0,
    sx: wrapDeltaX(s.x, fromX),
    sy: fromY - s.y,
  });
}

/** World position of a field item. Returns into the shared scratch pair. */
export const FIELD_POS = { x: 0, y: 0 };
export function fieldItemPos(s: Storm, it: FieldItem): typeof FIELD_POS {
  const fr = fieldRadius(s.mass);
  // Items spiral in over their first ~0.35s, so the catch reads as physics.
  const r = fr * it.rt * it.t;
  const a = it.ang + s.fieldRot * it.spin;
  FIELD_POS.x = wrapX(s.x + Math.cos(a) * r + it.sx * (1 - it.t));
  FIELD_POS.y = s.y + Math.sin(a) * r + it.sy * (1 - it.t);
  return FIELD_POS;
}

function updateField(s: Storm, dt: number): void {
  s.fieldRot += fieldSpin(s.mass) * dt * -s.spinDir;
  for (let i = 0; i < s.field.length; i++) {
    const it = s.field[i];
    if (it.t < 1) it.t = Math.min(1, it.t + dt * 3.2);
    it.wob += dt * 4;
  }
  // The field is capped by mass: shrinking storms shed items.
  const want = Math.min(CAP_FIELD_ITEMS, Math.max(4, Math.floor(s.mass * 0.55)));
  while (s.field.length > want) s.field.pop();
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export function applyInput(w: WorldState, s: Storm, input: Input, dt: number): void {
  // Coriolis: counter-clockwise north, clockwise south, flipping with a
  // visible unwind at the equator. Turning toward your spin is 8% faster.
  const wantSpin = s.y < EQUATOR_Y ? -1 : 1;
  if (wantSpin !== s.spinDir) {
    s.spinDir = wantSpin;
    s.spinFlip = CORIOLIS_FLIP_TIME;
    s.stats.equatorCrossings++;
    w.events.push({ type: 'equatorCross', storm: s.id, x: s.x, y: s.y, a: wantSpin, b: 0 });
  }
  if (s.spinFlip > 0) s.spinFlip = Math.max(0, s.spinFlip - dt);

  const canBoost = input.boosting && s.mass >= BOOST_MIN_MASS;
  s.boosting = canBoost;

  const delta = angleDelta(s.ang, input.steerAngle);
  // spinDir -1 is counter-clockwise, which in screen space is a decreasing
  // angle, so a negative delta is "toward your spin".
  const towardSpin = Math.sign(delta) === s.spinDir * -1;
  let turn = maxTurnRate(s.mass) * (towardSpin ? 1 + CORIOLIS_TURN_BONUS : 1);
  if (canBoost) turn *= BOOST_TURN_MUL;

  const step = turn * dt;
  s.ang += clamp(delta, -step, step);
  if (s.ang > Math.PI) s.ang -= Math.PI * 2;
  else if (s.ang < -Math.PI) s.ang += Math.PI * 2;
}

export function moveStorm(s: Storm, speedMul: number, dt: number): void {
  let sp = stormSpeed(s.mass) * speedMul;
  if (s.boosting) sp *= BOOST_SPEED_MUL;
  const dx = Math.cos(s.ang) * sp * dt;
  const dy = Math.sin(s.ang) * sp * dt;
  s.x = wrapX(s.x + dx);
  // Clamp at the ice caps rather than wrapping vertically.
  s.y = clamp(s.y + dy, 4, WORLD_H - 4);
  // Signed, so "lap the world" means an actual lap rather than pacing back
  // and forth across the same meridian.
  s.stats.distanceX += dx;
}

/** Boost ejects one pellet backward every 120ms carrying the lost mass. */
export function updateBoost(w: WorldState, s: Storm, dt: number, spawn: SpawnDebris): void {
  if (!s.boosting) {
    s.boostEjectTimer = 0;
    return;
  }
  s.stats.boostTime += dt;
  const lost = s.mass * BOOST_DRAIN * dt;
  s.mass = Math.max(MIN_MASS, s.mass - lost);
  s.boostEjectTimer += dt;
  if (s.boostEjectTimer >= BOOST_EJECT_INTERVAL) {
    s.boostEjectTimer -= BOOST_EJECT_INTERVAL;
    const back = s.ang + Math.PI;
    const r = fieldRadius(s.mass) * 0.8;
    // Rivals can eat your boost trail.
    spawn(
      w,
      wrapX(s.x + Math.cos(back) * r),
      s.y + Math.sin(back) * r,
      Math.cos(back) * 120,
      Math.sin(back) * 120,
      Math.max(0.6, lost / BOOST_EJECT_INTERVAL * 0.12),
      5,
      0,
    );
    w.events.push({ type: 'boostEject', storm: s.id, x: s.x, y: s.y, a: back, b: 0 });
  }
}

export type SpawnDebris = (
  w: WorldState,
  x: number,
  y: number,
  vx: number,
  vy: number,
  mass: number,
  type: number,
  cls: number,
) => void;

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/**
 * Contact = your eye overlaps any debris item in another storm's field.
 * Returns true if a shred landed.
 */
export function tryShred(w: WorldState, victim: Storm, attacker: Storm): boolean {
  if (victim.invuln > 0 || !victim.alive || !attacker.alive) return false;

  const er = eyeRadius(victim.mass);
  const fr = fieldRadius(attacker.mass);
  const dx = wrapDeltaX(victim.x, attacker.x);
  const dy = attacker.y - victim.y;
  const reach = er + fr;
  if (dx * dx + dy * dy > reach * reach) return false;

  for (let i = 0; i < attacker.field.length; i++) {
    const it = attacker.field[i];
    if (it.t < 0.6) continue; // still spiralling in, not yet a weapon
    const p = fieldItemPos(attacker, it);
    const ddx = wrapDeltaX(victim.x, p.x);
    const ddy = p.y - victim.y;
    const rr = er + 13;
    if (ddx * ddx + ddy * ddy < rr * rr) {
      applyShred(w, victim, attacker);
      return true;
    }
  }
  return false;
}

export function applyShred(w: WorldState, victim: Storm, attacker: Storm): void {
  const dx = wrapDeltaX(attacker.x, victim.x);
  const dy = victim.y - attacker.y;
  const d = Math.max(1, Math.hypot(dx, dy));

  if (w.instantDeathOnShred) {
    victim.mass = 0;
  } else {
    victim.mass *= 1 - SHRED_MASS_LOSS;
  }
  victim.x = wrapX(victim.x + (dx / d) * SHRED_KNOCKBACK);
  victim.y = clamp(victim.y + (dy / d) * SHRED_KNOCKBACK, 4, WORLD_H - 4);
  victim.invuln = SHRED_INVULN;
  victim.hurt = 0.35;
  victim.winTimer = 0;
  victim.drainingCity = -1;
  victim.stats.shredsTaken++;
  attacker.stats.shredsDealt++;

  w.events.push({
    type: 'shred',
    storm: victim.id,
    x: victim.x,
    y: victim.y,
    a: attacker.id,
    b: victim.mass,
  });
}

/** Eye-vs-eye: the larger absorbs 40% of the smaller. No instant kill. */
export function eyeCollide(w: WorldState, a: Storm, b: Storm): void {
  const big = a.mass >= b.mass ? a : b;
  const small = big === a ? b : a;
  if (small.invuln > 0) return;

  const take = small.mass * EYE_ABSORB;
  small.mass -= take;
  big.mass += take;

  const dx = wrapDeltaX(big.x, small.x);
  const dy = small.y - big.y;
  const d = Math.max(1, Math.hypot(dx, dy));
  small.x = wrapX(small.x + (dx / d) * EYE_THROW);
  small.y = clamp(small.y + (dy / d) * EYE_THROW, 4, WORLD_H - 4);
  small.invuln = SHRED_INVULN;
  small.hurt = 0.35;
  small.winTimer = 0;

  w.events.push({ type: 'eyeHit', storm: small.id, x: small.x, y: small.y, a: big.id, b: take });
}

// ---------------------------------------------------------------------------
// Per-storm tick shared by players and bots
// ---------------------------------------------------------------------------

export function tickStormTimers(s: Storm, dt: number): void {
  if (s.invuln > 0) s.invuln = Math.max(0, s.invuln - dt);
  if (s.hurt > 0) s.hurt = Math.max(0, s.hurt - dt);
  s.stats.aliveTime += dt;
  if (s.mass > s.stats.peakMass) s.stats.peakMass = s.mass;
  if (s.mass < s.stats.minMassSeen) s.stats.minMassSeen = s.mass;
  updateField(s, dt);
}

export function currentRank(s: Storm): number {
  return rankOf(s.mass);
}
