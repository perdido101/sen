#!/usr/bin/env node
/**
 * PHASE 0 ACCEPTANCE TEST
 *
 * Runs the simulation for 1000 steps with no renderer, twice, and asserts the
 * resulting state is byte-identical for the same seed. Seed + input log must
 * reproduce a run exactly - that gives replays and desync detection for free.
 *
 *   npm run sim:determinism
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';

import { createWorld } from '../packages/sim/src/sim/world.ts';
import { step } from '../packages/sim/src/sim/step.ts';
import { InputCollector } from '../packages/sim/src/bots/drive.ts';
import { rankOf, RANKS } from '../packages/sim/src/sim/constants.ts';

const STEPS = Number(process.argv[2] ?? 1000);
const SEED = Number(process.argv[3] ?? 12345);
const BOTS = Number(process.argv[4] ?? 64);

function loadTerrain() {
  const png = PNG.sync.read(readFileSync(new URL('../apps/client/public/terrain.png', import.meta.url)));
  return { w: png.width, h: png.height, data: new Uint8ClampedArray(png.data) };
}

const terrain = loadTerrain();

/**
 * Deterministic scripted player, so the run exercises movement, feeding and
 * combat without a human. This is the "input log" half of the contract.
 */
function scriptedPlayer(tick) {
  const t = tick / 60;
  return {
    steerAngle: Math.sin(t * 0.37) * Math.PI + Math.cos(t * 0.11) * 0.8,
    boosting: tick % 240 < 40,
  };
}

function run() {
  const w = createWorld({ seed: SEED, terrain, bots: BOTS });
  const inputs = new InputCollector();
  for (let i = 0; i < STEPS; i++) {
    const p = scriptedPlayer(i);
    inputs.setPlayer(w.playerId, p.steerAngle, p.boosting);
    step(w, inputs.collect(w));
  }
  return w;
}

/** Serialise everything that must match. Floats go in as raw 64-bit words. */
function fingerprint(w) {
  const nums = [];
  const push = (...v) => nums.push(...v);

  push(w.tick, w.rng, w.winner, w.over ? 1 : 0, w.debrisCursor);

  for (const s of w.storms) {
    push(
      s.id, s.alive ? 1 : 0, s.x, s.y, s.ang, s.mass, s.rank,
      s.spinDir, s.spinFlip, s.fieldRot, s.invuln, s.winTimer,
      s.drainingCity, s.botState, s.botTarget, s.botTimer, s.field.length,
      s.stats.stickmen, s.stats.trees, s.stats.cars, s.stats.cows,
      s.stats.ships, s.stats.shredsTaken, s.stats.shredsDealt,
    );
    for (const it of s.field) push(it.ang, it.rt, it.spin, it.type, it.cls, it.t);
  }

  for (const d of w.debris) push(d.active ? 1 : 0, d.x, d.y, d.vx, d.vy, d.mass);
  for (const m of w.stickmen) push(m.active ? 1 : 0, m.x, m.y, m.state, m.ph);
  for (const c of w.cities) push(c.reserve, c.rebuild, c.buildings.length, c.emptiedBy);

  const keys = [...w.chunks.keys()];
  push(keys.length, ...keys);
  for (const k of keys) {
    const c = w.chunks.get(k);
    let alive = 0;
    for (const p of c.props) if (p.alive) alive++;
    push(c.props.length, alive, c.stickmen.length);
  }

  for (let i = 0; i < w.sst.length; i++) push(w.sst[i]);

  const buf = Buffer.allocUnsafe(nums.length * 8);
  for (let i = 0; i < nums.length; i++) buf.writeDoubleLE(nums[i], i * 8);
  return { hash: createHash('sha256').update(buf).digest('hex'), bytes: buf };
}

console.log(`running ${STEPS} steps, seed ${SEED}, ${BOTS} bots, no renderer...`);

const t0 = process.hrtime.bigint();
const a = run();
const t1 = process.hrtime.bigint();
const b = run();

const fa = fingerprint(a);
const fb = fingerprint(b);

const ms = Number(t1 - t0) / 1e6;
console.log(`  run A: ${ms.toFixed(0)}ms for ${STEPS} steps (${(ms / STEPS).toFixed(3)}ms/step)`);
console.log(`  A ${fa.hash}`);
console.log(`  B ${fb.hash}`);

if (!fa.bytes.equals(fb.bytes)) {
  // Find the first differing word to make desyncs debuggable.
  let at = -1;
  for (let i = 0; i < Math.min(fa.bytes.length, fb.bytes.length); i += 8) {
    if (fa.bytes.readDoubleLE(i) !== fb.bytes.readDoubleLE(i)) {
      at = i / 8;
      break;
    }
  }
  console.error(`\nFAIL: states diverged at word ${at} ` +
    `(${fa.bytes.readDoubleLE(at * 8)} vs ${fb.bytes.readDoubleLE(at * 8)})`);
  process.exit(1);
}

// Report what actually happened, so this doubles as a balance probe.
const p = a.storms[a.playerId];
const ranks = a.storms.filter((s) => s.alive).map((s) => rankOf(s.mass));
const biggest = a.storms.reduce((m, s) => (s.alive && s.mass > m.mass ? s : m), a.storms[0]);
const emptied = a.cities.filter((c) => c.reserve < c.reserveMax).length;

console.log(
  `\nPASS: byte-identical after ${STEPS} steps.\n` +
  `  player: ${p.alive ? 'alive' : 'dissipated'} mass ${p.mass.toFixed(1)} ` +
  `rank ${RANKS[rankOf(p.mass) - 1].key} peak ${p.stats.peakMass.toFixed(1)}\n` +
  `  biggest storm: ${biggest.name} ${biggest.mass.toFixed(0)}${biggest.isLaNina ? ' (La Nina)' : ''}\n` +
  `  ranks alive: ${ranks.sort((x, y) => x - y).join(',')}\n` +
  `  cities touched: ${emptied}  chunks loaded: ${a.chunks.size}  ` +
  `stickmen: ${a.stickmen.filter((m) => m.active).length}`,
);
