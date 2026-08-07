#!/usr/bin/env node
/**
 * PHASE 11 / 12 acceptance.
 *
 * Boots the real server, connects simulated clients over a real socket, and
 * measures what the brief says to fail the phase over: snapshot rate,
 * bandwidth per client, sim tick rate under load, and the one that matters
 * most - that a client cannot produce a mass value the server did not
 * authorize.
 *
 *   node tools/server-test.mjs [clients] [seconds]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Msg,
  Reader,
  Writer,
  readSnapshot,
  readWelcome,
  writeInput,
} from '../packages/protocol/src/index.ts';

const CLIENTS = Number(process.argv[2] ?? 12);
const SECONDS = Number(process.argv[3] ?? 8);
const PORT = 8899;

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

console.log(`booting server on :${PORT} ...`);
const server = spawn('node', ['apps/server/src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), SEN_DATA_DIR: '/tmp/sen-test-data' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return await r.json();
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`server never became healthy:\n${serverLog}`);
}

const health = await waitForHealth();
console.log(`server up: ${health.instances.length} instance(s), ${health.instances[0].storms} storms`);

// ---------------------------------------------------------------------------

class SimClient {
  constructor(i) {
    this.i = i;
    this.bytes = 0;
    this.snapshots = 0;
    this.welcome = null;
    this.baseline = null;
    this.selfMass = 0;
    this.seenMasses = [];
    this.seq = 0;
    this.writer = new Writer(64);
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/play?name=T${i}`);
    this.ws.binaryType = 'arraybuffer';
    this.ready = new Promise((res) => (this.resolve = res));

    this.ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data);
      this.bytes += bytes.byteLength;
      const r = new Reader(bytes);
      const type = r.u8();
      if (type === Msg.Welcome) {
        this.welcome = readWelcome(r);
        this.resolve();
      } else if (type === Msg.Snapshot) {
        const snap = readSnapshot(r, this.baseline);
        this.snapshots++;
        const next = new Map();
        for (const e of snap.entities) next.set(e.id, e);
        for (const id of snap.removed) next.delete(id);
        this.baseline = next;
        const me = next.get(snap.head.selfId);
        if (me !== undefined) {
          this.selfMass = me.mass;
          this.seenMasses.push(me.mass);
        }
      }
    };
  }

  send(steerAngle, boosting) {
    if (this.ws.readyState !== 1) return;
    this.writer.reset();
    writeInput(this.writer, { seq: this.seq++ & 0xffff, steerAngle, boosting });
    this.ws.send(this.writer.bytes().slice());
  }

  /** Try to claim mass the server never granted. There is nowhere to put it. */
  sendForged() {
    if (this.ws.readyState !== 1) return;
    const w = new Writer(64);
    writeInput(w, { seq: this.seq++ & 0xffff, steerAngle: 0, boosting: false });
    // Append a fabricated mass field on the end of a legal packet.
    const legal = w.bytes().slice();
    const forged = new Uint8Array(legal.length + 4);
    forged.set(legal);
    new DataView(forged.buffer).setUint32(legal.length, 60000);
    this.ws.send(forged);
  }

  /** Garbage the server must survive. */
  sendGarbage() {
    if (this.ws.readyState !== 1) return;
    this.ws.send(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

console.log(`connecting ${CLIENTS} clients ...`);
const clients = [];
for (let i = 0; i < CLIENTS; i++) clients.push(new SimClient(i));
await Promise.all(clients.map((c) => c.ready));
console.log('all connected');

check(
  clients.every((c) => c.welcome !== null && c.welcome.version === 1),
  'every client received a Welcome',
);
// Storm ids are unique within an instance, not across the pool: matchmaking
// opens a second world once the first passes its occupancy threshold, and two
// players in different worlds sharing an id is correct - ids are only ever
// resolved against the instance the client was welcomed into.
const perInstance = new Map();
for (const c of clients) {
  const key = c.welcome.instance;
  if (!perInstance.has(key)) perInstance.set(key, new Set());
  perInstance.get(key).add(c.welcome.selfId);
}
const totalIds = [...perInstance.values()].reduce((n, set) => n + set.size, 0);
check(
  totalIds === CLIENTS,
  `every client got a storm id unique in its instance (${totalIds}/${CLIENTS} across ` +
    `${perInstance.size} instance(s))`,
);

// Play: steer in circles at 30Hz, which is the real client rate.
const t0 = Date.now();
const inputTimer = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  for (const c of clients) c.send(Math.sin(t * 0.6 + c.i) * Math.PI, t % 4 < 1);
}, 1000 / 30);

// Two clients misbehave the entire time.
const abuseTimer = setInterval(() => {
  clients[0].sendForged();
  if (clients.length > 1) clients[1].sendGarbage();
}, 20);

await sleep(SECONDS * 1000);
clearInterval(inputTimer);
clearInterval(abuseTimer);

const elapsed = (Date.now() - t0) / 1000;
const health2 = await waitForHealth();

// ---------------------------------------------------------------------------

const totalBytes = clients.reduce((n, c) => n + c.bytes, 0);
const perClientKBs = totalBytes / elapsed / 1024 / CLIENTS;
const snapsPerSec = clients.reduce((n, c) => n + c.snapshots, 0) / elapsed / CLIENTS;

console.log(`\n  snapshot rate   ${snapsPerSec.toFixed(1)} Hz per client (target 15)`);
console.log(`  bandwidth down  ${perClientKBs.toFixed(2)} KB/s per client (ceiling 15)`);
console.log(`  sim step        ${health2.avgStepMs.toFixed(2)} ms avg`);
console.log(`  instances       ${health2.instances.length}, humans ${health2.humans}`);

check(snapsPerSec > 12 && snapsPerSec < 18, `snapshot rate is ~15Hz, got ${snapsPerSec.toFixed(1)}`);
check(perClientKBs < 15, `bandwidth under 15KB/s per client, got ${perClientKBs.toFixed(1)}`);
check(health2.avgStepMs < 16.6, `sim step fits in a 60Hz budget, got ${health2.avgStepMs.toFixed(2)}ms`);
check(health2.humans === CLIENTS, `server sees all ${CLIENTS} humans, saw ${health2.humans}`);

// The point of the whole design: the forger's mass is normal.
const forger = clients[0];
const others = clients.slice(2);
const median = (a) => (a.length === 0 ? 0 : a.slice().sort((x, y) => x - y)[a.length >> 1]);
const othersMedian = median(others.map((c) => c.selfMass));
console.log(`  forged-mass client ended at ${forger.selfMass}, others median ${othersMedian}`);
check(forger.selfMass < 60000, 'the forged mass value never took effect');
check(
  forger.selfMass < Math.max(400, othersMedian * 8),
  'the forging client is not an outlier in mass',
);
check(forger.ws.readyState === 1, 'the server survived a client sending garbage');

for (const c of clients) c.close();
await sleep(500);
server.kill('SIGTERM');
await sleep(300);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n--- server log ---\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log('\nserver OK');
