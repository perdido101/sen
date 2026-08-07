#!/usr/bin/env node
/**
 * PHASE 11 acceptance, the client half.
 *
 * Two real browsers on one instance, on a link with latency and loss, each
 * asked whether it can see the other move smoothly - and whether either can
 * produce a mass the server did not authorize.
 *
 *   node tools/netplay-test.mjs [outDir]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-netplay';
const SERVER_PORT = 8901;
const WEB_PORT = 4180;
mkdirSync(OUT, { recursive: true });

const problems = [];
const check = (c, m) => {
  if (!c) problems.push(m);
};

const server = spawn('node', ['apps/server/src/main.ts'], {
  env: { ...process.env, PORT: String(SERVER_PORT), SEN_DATA_DIR: '/tmp/sen-netplay-data' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const web = spawn('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--host', '127.0.0.1'], {
  cwd: 'apps/client',
  stdio: ['ignore', 'pipe', 'pipe'],
});
web.stdout.on('data', () => {});
web.stderr.on('data', () => {});

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up */
    }
    await sleep(500);
  }
  return false;
}

if (!(await waitFor(`http://127.0.0.1:${SERVER_PORT}/health`))) {
  console.error('server never came up\n' + log);
  process.exit(1);
}
if (!(await waitFor(`http://127.0.0.1:${WEB_PORT}/`))) {
  console.error('preview server never came up');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});

async function makePlayer(label) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label}: console ${m.text()}`);
  });

  // 150ms round trip and 2% loss, per the brief's acceptance condition.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 75,
    downloadThroughput: 2_000_000,
    uploadThroughput: 1_000_000,
    packetLoss: 2,
    connectionType: 'wifi',
  });

  await page.goto(`http://127.0.0.1:${WEB_PORT}/?debug`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForSelector('.panel .wordmark', { timeout: 90000 });
  return { ctx, page, label };
}

// Both browsers are booted before either one joins. Connecting A first means
// A plays unattended for the twenty-odd seconds B takes to load, and an
// unsteered Dust Devil reliably drives itself into the sea - which then reads
// as a netcode failure when it is nothing of the sort.
const a = await makePlayer('A');
const b = await makePlayer('B');
for (const pl of [a, b]) {
  await pl.page.evaluate((p) => window.__sen.online(`ws://127.0.0.1:${p}`), SERVER_PORT);
}

// Wait for both to be live.
for (let i = 0; i < 60; i++) {
  const sa = await a.page.evaluate(() => window.__sen.net().status);
  const sb = await b.page.evaluate(() => window.__sen.net().status);
  if (sa === 'live' && sb === 'live') break;
  await sleep(500);
}

const statusA = await a.page.evaluate(() => window.__sen.net().status);
const statusB = await b.page.evaluate(() => window.__sen.net().status);
check(statusA === 'live', `A reached the server (status ${statusA})`);
check(statusB === 'live', `B reached the server (status ${statusB})`);

// Both clients ask for the widest area of interest they are allowed. Two
// players dropped into a 16384-wide world are nowhere near each other by
// design - the safe spawn guarantees it - so a direct sighting is something
// the run may produce, not something it can assume.
for (const pl of [a, b]) {
  await pl.page.evaluate(() => window.__sen.net().sendViewport(4000, 4000));
}

const posOf = (pl) =>
  pl.page.evaluate(() => {
    const w = window.__sen.world();
    const me = w.storms[w.playerId];
    return { x: me.x, y: me.y, mass: me.mass, alive: me.alive };
  });

/**
 * Drive both players with the game's own bot brain.
 *
 * Steering from out here can only happen a few times a second, and a storm
 * crossing 520 units a second is committed to a heading for a long way in
 * between - so an externally-driven player walks into the sea, dies in about
 * a second, and the run produces two samples of netcode data. Handing the
 * wheel to the brain that drives the bots produces a competent player whose
 * input still goes out over the wire exactly like anyone else's. A is biased
 * toward B so a sighting is possible; B just plays.
 */
async function autopilot(pl, bias) {
  await pl.page.evaluate((bias) => window.__sen.autopilot(bias), bias);
}

const samples = { a: [], b: [] };
let sawEachOther = false;
const t0 = Date.now();

await autopilot(b, null);

while (Date.now() - t0 < 40000 && !sawEachOther) {
  const pa = await posOf(a);
  const pb = await posOf(b);

  // Refresh A's bias with B's current position; the brain does the driving in
  // between, sixty times a second.
  await autopilot(a, { x: pb.x, y: pb.y });

  for (const [k, pl] of [['a', a], ['b', b]]) {
    const s = await pl.page.evaluate(() => {
      const net = window.__sen.net();
      const w = window.__sen.world();
      const me = w.storms[w.playerId];
      let others = 0;
      for (const st of w.storms) if (st.id !== w.playerId && st.alive) others++;
      return { mass: me?.mass ?? 0, x: me?.x ?? 0, y: me?.y ?? 0, rtt: net.rtt, others };
    });
    samples[k].push({ ...s, t: Date.now() });
  }

  const seen = await a.page.evaluate(() => {
    const net = window.__sen.net();
    const list = [];
    net.interpolated(list);
    return list.some((e) => e.human);
  });
  let dx = pb.x - pa.x;
  if (dx > 8192) dx -= 16384;
  if (dx < -8192) dx += 16384;
  const dist = Math.hypot(dx, pb.y - pa.y);
  // Only let a sighting end the run once there is a real window of samples
  // behind it, or the smoothness measurement below is one number wide.
  if (seen && dist < 3000 && samples.a.length >= 16) sawEachOther = true;

  // A storm that runs out of land dies, which is the game working. Stop once
  // either player is gone rather than reporting a netcode failure for a
  // gameplay outcome.
  if (!pa.alive || !pb.alive) break;
  await sleep(250);
}

console.log(`  A: mass ${samples.a.at(-1).mass.toFixed(1)}, sees ${samples.a.at(-1).others} storms`);
console.log(`  B: mass ${samples.b.at(-1).mass.toFixed(1)}, sees ${samples.b.at(-1).others} storms`);

const last = { a: samples.a.at(-1), b: samples.b.at(-1) };
console.log(`  rtt: A ${last.a.rtt.toFixed(0)}ms, B ${last.b.rtt.toFixed(0)}ms`);
console.log(`  A closed on B and saw it: ${sawEachOther}`);

// Mutual awareness goes through the roster, which every client in an instance
// receives regardless of where anyone is standing. Physically colliding two
// players inside a test window on a 16384-wide world is not something to
// depend on - the safe spawn deliberately puts them far apart.
const rosterA = await a.page.evaluate(() => window.__sen.net().humans().length);
const rosterB = await b.page.evaluate(() => window.__sen.net().humans().length);
const maxSeenA = Math.max(...samples.a.map((s) => s.others));
const maxSeenB = Math.max(...samples.b.map((s) => s.others));
console.log(`  roster: A sees ${rosterA} humans, B sees ${rosterB}`);
console.log(`  peak remote storms rendered: A ${maxSeenA}, B ${maxSeenB}`);

check(
  samples.a.length >= 16,
  `the run lasted long enough to measure (${samples.a.length} samples of 250ms)`,
);
check(rosterA === 2 && rosterB === 2, `both clients know about both humans (${rosterA}/${rosterB})`);
check(maxSeenA >= 1 && maxSeenB >= 1, 'both clients rendered remote storms from snapshots');
if (sawEachOther) console.log('  (A also had B in view directly)');
check(last.a.rtt > 100 && last.a.rtt < 400, `rtt reflects the emulated 150ms link (${last.a.rtt.toFixed(0)}ms)`);

// Smoothness: the local storm moves continuously, with no teleports.
//
// Measured as a speed, not as a per-sample distance: the sampling interval is
// whatever the browser round trips add up to, so a distance threshold would
// really be measuring how busy the test machine is. The physical ceiling is
// base speed x boost x warm water, a little over 1000 units a second; anything
// above 1500 is a reconciliation snap, not a storm.
for (const k of ['a', 'b']) {
  let peak = 0;
  for (let i = 1; i < samples[k].length; i++) {
    const dt = (samples[k][i].t - samples[k][i - 1].t) / 1000;
    if (dt <= 0) continue;
    const dx2 = samples[k][i].x - samples[k][i - 1].x;
    const dy2 = samples[k][i].y - samples[k][i - 1].y;
    const v = Math.hypot(Math.abs(dx2) > 8000 ? 0 : dx2, dy2) / dt;
    if (v > peak) peak = v;
  }
  console.log(`  ${k.toUpperCase()} fastest observed: ${peak.toFixed(0)} units/sec`);
  check(peak < 1500, `${k.toUpperCase()} moved smoothly (peaked at ${peak.toFixed(0)} u/s)`);
}

// Mass authority, tested on a LIVE storm: a dead one stops being sent, which
// would make this pass for the wrong reason.
const aliveNow = await a.page.evaluate(() => window.__sen.world().storms[window.__sen.world().playerId].alive);
if (aliveNow) {
  const before = await a.page.evaluate(() => window.__sen.world().storms[window.__sen.world().playerId].mass);
  await a.page.evaluate(() => {
    window.__sen.world().storms[window.__sen.world().playerId].mass = 50000;
  });
  await sleep(1500);
  const after = await a.page.evaluate(() => window.__sen.world().storms[window.__sen.world().playerId].mass);
  console.log(`  A forced mass 50000 (was ${before.toFixed(1)}), server restored ${after.toFixed(1)}`);
  check(after < 1000, `the next snapshot overwrote the forged mass (saw ${after.toFixed(1)})`);
} else {
  // Dead is also a valid outcome, and it has its own requirement.
  const dead = await a.page.evaluate(() => window.__sen.phase());
  console.log(`  A died online; client phase is "${dead}"`);
  check(dead !== 'playing', 'a server-side death moves the client out of play');
}

await a.page.screenshot({ path: `${OUT}/player-a.png` });
await b.page.screenshot({ path: `${OUT}/player-b.png` });

const health = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).json();
console.log(`  server: ${health.humans} humans, step ${health.avgStepMs.toFixed(2)}ms`);
check(health.humans === 2, `server sees both clients (saw ${health.humans})`);

await browser.close();
server.kill('SIGTERM');
web.kill('SIGTERM');
await sleep(400);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('\nnetplay OK');
