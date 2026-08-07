#!/usr/bin/env node
/**
 * PHASE 11 - protocol tests.
 *
 * The wrap seam is the trap the brief warns about, and every wrap bug from
 * Brief 1 resurfaces here in a new form, so it gets its own tests. So does the
 * delta encoder, because a delta bug looks like lag rather than like a bug.
 */

import { strict as assert } from 'node:assert';
import {
  Reader,
  Writer,
  Flag,
  Field,
  packX,
  packY,
  packAngle,
  unpackAngle,
  unpackX,
  readInput,
  readSnapshot,
  writeInput,
  writeSnapshot,
  readWelcome,
  writeWelcome,
} from '../packages/protocol/src/index.ts';
import { WORLD_H, WORLD_W, wrapDeltaX } from '../packages/sim/src/sim/constants.ts';

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// --------------------------------------------------------------- quantisation
{
  for (let i = 0; i < 2000; i++) {
    const x = (i / 2000) * WORLD_W;
    const back = unpackX(packX(x));
    ok(Math.abs(back - x) <= WORLD_W / 65536, `x quantisation at ${x}`);
  }
  // The wrap seam must round-trip: WORLD_W and 0 are the same place.
  ok(packX(WORLD_W) === packX(0), 'the seam quantises to one value');
  ok(packY(-50) === 0 && packY(WORLD_H * 2) === 65535, 'y clamps at the caps');

  for (let i = -8; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    const back = unpackAngle(packAngle(a));
    const d = Math.atan2(Math.sin(a - back), Math.cos(a - back));
    ok(Math.abs(d) < 0.0125, `angle within 1.4 degrees at ${a}`);
  }
}

// ------------------------------------------------------------- input packet
{
  const w = new Writer();
  writeInput(w, { seq: 65535, steerAngle: -Math.PI / 2, boosting: true });
  ok(w.length === 5, `input packet is 5 bytes, got ${w.length}`);

  const r = new Reader(w.bytes().slice());
  r.u8();
  const p = readInput(r);
  ok(p.seq === 65535, 'seq round-trips at the uint16 boundary');
  ok(p.boosting === true, 'boost bit round-trips');
  ok(Math.abs(p.steerAngle - -Math.PI / 2) < 0.02, 'angle round-trips');

  // The authority surface: there is nowhere in this packet to put mass.
  const fields = Object.keys(p);
  ok(
    fields.length === 3 && !fields.includes('mass') && !fields.includes('x'),
    'the input packet carries a heading and a boost bit and nothing else',
  );
}

// ------------------------------------------------------------------ welcome
{
  const w = new Writer();
  writeWelcome(w, {
    version: 1, selfId: 7, seed: 0xdeadbeef | 0, worldW: WORLD_W, worldH: WORLD_H,
    tickRate: 60, snapshotRate: 15, instance: 'eu-west-0',
  });
  const r = new Reader(w.bytes().slice());
  r.u8();
  const m = readWelcome(r);
  ok(m.selfId === 7 && m.instance === 'eu-west-0', 'welcome round-trips');
  ok(m.worldW === WORLD_W && m.worldH === WORLD_H, 'world bounds round-trip');
}

// ---------------------------------------------------------------- snapshots
function ent(id, x, y, ang = 0, mass = 100, flags = 0) {
  return { id, x, y, ang, mass, flags };
}

{
  // Full snapshot, then a delta where only one entity moved.
  const a = [ent(1, 100, 200, 0.5, 50), ent(2, 300, 400, 1.5, 900, Flag.Boosting)];
  const w = new Writer();
  writeSnapshot(w, { tick: 10, ackSeq: 3, baseTick: 0, selfId: 1 }, a, null);
  const fullBytes = w.length;

  const r = new Reader(w.bytes().slice());
  r.u8();
  const full = readSnapshot(r, null);
  ok(full.entities.length === 2, 'full snapshot carries both entities');
  ok(Math.abs(full.entities[0].x - 100) < 0.5, 'position survives the round trip');
  ok(full.entities[1].flags === Flag.Boosting, 'flags survive');

  const baseline = new Map(full.entities.map((e) => [e.id, e]));
  const b = [ent(1, 140, 200, 0.5, 50), ent(2, 300, 400, 1.5, 900, Flag.Boosting)];
  const w2 = new Writer();
  writeSnapshot(w2, { tick: 11, ackSeq: 4, baseTick: 10, selfId: 1 }, b, baseline);
  ok(
    w2.length < fullBytes,
    `a delta is smaller than a full snapshot (${w2.length} vs ${fullBytes})`,
  );

  const r2 = new Reader(w2.bytes().slice());
  r2.u8();
  const delta = readSnapshot(r2, baseline);
  ok(Math.abs(delta.entities[0].x - 140) < 0.5, 'the moved entity updated');
  ok(
    Math.abs(delta.entities[1].y - 400) < 0.5 && delta.entities[1].mass === 900,
    'the still entity kept its baseline values',
  );
}

{
  // Removals.
  const a = [ent(1, 10, 10), ent(2, 20, 20), ent(3, 30, 30)];
  const w = new Writer();
  writeSnapshot(w, { tick: 1, ackSeq: 0, baseTick: 0, selfId: 1 }, a, null);
  const r = new Reader(w.bytes().slice());
  r.u8();
  const base = new Map(readSnapshot(r, null).entities.map((e) => [e.id, e]));

  const w2 = new Writer();
  writeSnapshot(w2, { tick: 2, ackSeq: 0, baseTick: 1, selfId: 1 }, [a[0]], base);
  const r2 = new Reader(w2.bytes().slice());
  r2.u8();
  const d = readSnapshot(r2, base);
  ok(d.removed.length === 2 && d.removed.includes(2) && d.removed.includes(3),
    'entities that left the view are sent as removals');
}

{
  // An entity the client has never seen must arrive complete even mid-stream.
  const base = new Map([[1, ent(1, 0, 0)]]);
  const w = new Writer();
  writeSnapshot(w, { tick: 3, ackSeq: 0, baseTick: 2, selfId: 1 },
    [ent(1, 0, 0), ent(9, 777, 888, 1, 1234, Flag.LaNina)], base);
  const r = new Reader(w.bytes().slice());
  r.u8();
  const d = readSnapshot(r, base);
  const nine = d.entities.find((e) => e.id === 9);
  ok(nine !== undefined, 'the new entity is present');
  ok(Math.abs(nine.x - 777) < 0.5 && nine.mass === 1234 && nine.flags === Flag.LaNina,
    'a spawn carries every field even though it is a delta packet');
}

// -------------------------------------------------------------- the wrap seam
{
  // An entity just across the seam from the camera must resolve to the near
  // representation, not to a position most of a planet away.
  const camera = WORLD_W - 50;
  const entity = 40; // 90 units east of the camera, across the seam
  const d = wrapDeltaX(camera, entity);
  ok(Math.abs(d - 90) < 0.001, `wrapDeltaX across the seam is 90, got ${d}`);

  // And that survives quantisation, which is where it would silently break.
  const qCam = unpackX(packX(camera));
  const qEnt = unpackX(packX(entity));
  const qd = wrapDeltaX(qCam, qEnt);
  ok(Math.abs(qd - 90) < 1, `quantised seam delta is still ~90, got ${qd}`);

  // Both sides of the seam count as near for area of interest.
  const halfW = 800;
  ok(Math.abs(wrapDeltaX(camera, entity)) < halfW, 'seam-crossing entity is inside AOI');
  ok(Math.abs(wrapDeltaX(camera, WORLD_W / 2)) > halfW, 'the far side is outside AOI');
}

// ---------------------------------------------------------------- bandwidth
{
  // The brief's budget: ~60 visible entities, 15Hz, under 15KB/s down.
  const entities = [];
  for (let i = 0; i < 60; i++) {
    entities.push(ent(i, Math.random() * WORLD_W, Math.random() * WORLD_H, Math.random(), 100 + i));
  }
  const w = new Writer();
  writeSnapshot(w, { tick: 1, ackSeq: 0, baseTick: 0, selfId: 0 }, entities, null);
  const fullPerSec = (w.length * 15) / 1024;

  const base = new Map(entities.map((e) => [e.id, { ...e }]));
  for (const e of entities) e.x += 3; // everything moving, the worst realistic case
  const w2 = new Writer();
  writeSnapshot(w2, { tick: 2, ackSeq: 0, baseTick: 1, selfId: 0 }, entities, base);
  const deltaPerSec = (w2.length * 15) / 1024;

  console.log(
    `  60 entities: full ${w.length}B (${fullPerSec.toFixed(1)}KB/s), ` +
    `all-moving delta ${w2.length}B (${deltaPerSec.toFixed(1)}KB/s)`,
  );
  ok(deltaPerSec < 15, `delta stream is under the 15KB/s ceiling (${deltaPerSec.toFixed(1)})`);
}

console.log(`protocol OK - ${checks} assertions`);
void Field;
