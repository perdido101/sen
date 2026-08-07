#!/usr/bin/env node
/**
 * PHASE 10 acceptance: an instance runs for an hour with flat memory.
 *
 * Boots the real server, holds a full house of simulated clients on it, and
 * samples RSS the whole way. The failure this exists to catch is not a crash -
 * it is a slow leak that only shows up after the thing has been live long
 * enough to matter, when storms have died and respawned thousands of times,
 * chunks have streamed in and out, and every pooled array has been recycled
 * many times over.
 *
 *   node tools/soak.mjs [minutes] [clients]
 *
 * The default is 10 minutes, which catches an ordinary leak in a couple of
 * minutes of wall clock. `npm run soak -- 60` is the acceptance run.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Msg, Reader, Writer, readSnapshot, readWelcome, writeInput } from '../packages/protocol/src/index.ts';

const MINUTES = Number(process.argv[2] ?? 10);
const CLIENTS = Number(process.argv[3] ?? 20);
const PORT = 8903;

const problems = [];
const check = (c, m) => {
  if (!c) problems.push(m);
};

const server = spawn('node', ['apps/server/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), SEN_DATA_DIR: '/tmp/sen-soak-data' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function health(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server never became healthy:\n${serverLog}`);
}

await health();
console.log(`soaking ${MINUTES} minute(s) with ${CLIENTS} clients on :${PORT}`);

/**
 * A client that plays rather than idles: it steers, boosts, dies and rejoins.
 * An idle socket exercises none of the pools that would actually leak.
 */
class Player {
  constructor(i) {
    this.i = i;
    this.seq = 0;
    this.writer = new Writer(64);
    this.baseline = null;
    this.snapshots = 0;
    this.reconnects = 0;
    this.open();
  }

  open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/play?name=S${this.i}`);
    this.ws.binaryType = 'arraybuffer';
    this.baseline = null;
    this.ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data);
      const r = new Reader(bytes);
      const type = r.u8();
      if (type === Msg.Welcome) {
        this.welcome = readWelcome(r);
      } else if (type === Msg.Snapshot) {
        const snap = readSnapshot(r, this.baseline);
        const next = new Map();
        for (const e of snap.entities) next.set(e.id, e);
        if (this.baseline !== null) {
          for (const [id, e] of this.baseline) {
            if (!next.has(id) && !snap.removed.includes(id)) next.set(id, e);
          }
        }
        this.baseline = next;
        this.snapshots++;
      }
    };
    this.ws.onclose = () => {
      // Churn is the point: rejoining exercises the storm-slot recycler, the
      // run recorder and the roster path that a static soak never touches.
      this.reconnects++;
      setTimeout(() => this.open(), 500 + this.i * 20);
    };
    this.ws.onerror = () => {};
  }

  drive(t) {
    if (this.ws.readyState !== 1) return;
    this.writer.reset();
    writeInput(this.writer, {
      seq: this.seq++ & 0xffff,
      steerAngle: Math.sin(t * 0.3 + this.i) * Math.PI,
      boosting: (this.i + Math.floor(t)) % 7 === 0,
    });
    this.ws.send(this.writer.bytes().slice());
  }

  cycle() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

const players = [];
for (let i = 0; i < CLIENTS; i++) players.push(new Player(i));
await sleep(2000);

const samples = [];
const started = Date.now();
const totalMs = MINUTES * 60_000;
let t = 0;

while (Date.now() - started < totalMs) {
  t += 0.05;
  for (const p of players) p.drive(t);
  // Every 20s one client leaves and comes back, so the join/leave path is
  // soaked too rather than just the steady state.
  if (Math.round(t * 20) % 400 === 0) players[Math.floor(t) % players.length].cycle();

  if (Math.round(t * 20) % 200 === 0) {
    const h = await health();
    samples.push({ at: Date.now() - started, rss: h.rssMb, heap: h.heapMb, step: h.avgStepMs });
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `  ${mins}m  rss ${h.rssMb.toFixed(1)}MB  heap ${h.heapMb.toFixed(1)}MB  ` +
        `step ${h.avgStepMs.toFixed(2)}ms  humans ${h.humans}`,
    );
  }
  await sleep(50);
}

// Ignore the first fifth: that is warm-up, JIT and pool growth, not a leak.
const warm = samples.slice(Math.floor(samples.length / 5));
const first = warm[0];
const last = warm[warm.length - 1];
const peak = Math.max(...warm.map((s) => s.rss));
const growthMb = last.rss - first.rss;
const perHour = (growthMb / ((last.at - first.at) / 3_600_000)) || 0;
const reconnects = players.reduce((n, p) => n + p.reconnects, 0);
const snaps = players.reduce((n, p) => n + p.snapshots, 0);

console.log('');
console.log(`  samples          ${samples.length} over ${MINUTES} minute(s)`);
console.log(`  rss              ${first.rss.toFixed(1)} -> ${last.rss.toFixed(1)} MB (peak ${peak.toFixed(1)})`);
console.log(`  drift            ${growthMb >= 0 ? '+' : ''}${growthMb.toFixed(1)} MB, ${perHour.toFixed(1)} MB/hour`);
console.log(`  snapshots read   ${snaps}`);
console.log(`  rejoins          ${reconnects}`);
console.log(`  step time        ${last.step.toFixed(2)}ms avg`);

// A leak shows up as monotonic growth. Node's heap wanders by a few MB either
// way between GCs, so the bar is a rate, not a delta - 25MB/hour would be 600MB
// on a machine that is supposed to run for days.
check(perHour < 25, `memory is flat (drifting ${perHour.toFixed(1)} MB/hour)`);
check(last.step < 8, `sim still inside its budget at the end (${last.step.toFixed(2)}ms)`);

for (const p of players) {
  p.ws.onclose = () => {};
  try {
    p.ws.close();
  } catch {
    /* already gone */
  }
}
server.kill('SIGTERM');
await sleep(400);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('\nsoak OK');
