/**
 * SUPER EL NINO server.
 *
 * The Brief 1 simulation running headless with sockets bolted on. The sim
 * ticks at a true 60Hz - unchanged from Brief 1, deliberately not retuned for
 * the network - and snapshots go out at 15Hz. A few hundred entities at 60Hz
 * is cheap; the network is the constraint, not the CPU.
 *
 *   npm run server
 */

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import uWS from 'uWebSockets.js';

import { FIXED_DT, WORLD_H, WORLD_W, createWorld, step } from '@sen/sim';
import type { TerrainData } from '@sen/sim';
import {
  EVENT_ID,
  Msg,
  Reader,
  Writer,
  readInput,
  writeEvents,
  writeRoster,
  writeSnapshot,
  writeWelcome,
  type NetEntity,
} from '@sen/protocol';

import { InstancePool } from './matchmaking.ts';
import { rateCheck, steeringLooksSynthetic, flag, Flagged } from './anticheat.ts';
import type { Client, Instance } from './instance.ts';
import { recordRun, accountForDevice, upgradeAccount, linkWallet } from './persistence.ts';
import { dashboardHtml, dashboardJson } from './dashboard.ts';
import { tick as buybackTick, publicState } from './token.ts';
import { grantReward, ingestNetworkReport, recordImpression, PLACEMENTS, adConfig, type Placement } from './revenue.ts';
import { analyse } from './collusion.ts';
import { dailySeed, epochName, settleEpoch, tournamentBoard } from './epochs.ts';
import { validateReplay } from './anticheat.ts';

const PORT = Number(process.env.PORT ?? 8787);
const REGION = process.env.SEN_REGION ?? 'eu-west';
const TICK_HZ = 60;
const SNAPSHOT_HZ = 15;
const MAX_HUMANS = Number(process.env.SEN_MAX_HUMANS ?? 60);
const TARGET_STORMS = Number(process.env.SEN_TARGET_STORMS ?? 80);

// ---------------------------------------------------------------------------

function loadTerrain(): TerrainData {
  const url = new URL('../../client/public/terrain.png', import.meta.url);
  const png = PNG.sync.read(readFileSync(url));
  return { w: png.width, h: png.height, data: new Uint8ClampedArray(png.data) };
}

const terrain = loadTerrain();

const pool = new InstancePool({
  terrain,
  region: REGION,
  maxHumans: MAX_HUMANS,
  targetStorms: TARGET_STORMS,
  spawnThreshold: 0.8,
  seedFor: (i) => (0x5e10000 + i * 7919) | 0,
});

interface Socket {
  clientId: number;
  instance: Instance;
  client: Client;
}

let nextClientId = 1;
const sockets = new Map<number, uWS.WebSocket<Socket>>();

// Scratch, reused for every client every snapshot: at 60 clients and 15Hz this
// is the one place that would otherwise allocate megabytes a second.
const writer = new Writer(64 * 1024);
const entityScratch: NetEntity[] = [];

// ---------------------------------------------------------------------------
// Metrics, for the bandwidth budget the brief says to fail the phase over
// ---------------------------------------------------------------------------

const metrics = {
  bytesOut: 0,
  bytesIn: 0,
  snapshots: 0,
  ticks: 0,
  lastReport: Date.now(),
  peakStepMs: 0,
  stepMsSum: 0,
};

// ---------------------------------------------------------------------------

const app = uWS.App();

app.ws<Socket>('/play', {
  compression: uWS.DISABLED,
  maxPayloadLength: 256,
  idleTimeout: 32,

  upgrade: (res, req, context) => {
    const name = (req.getQuery('name') ?? '').slice(0, 16) || 'Storm';
    res.upgrade(
      { name },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context,
    );
  },

  open: (ws) => {
    const data = ws.getUserData() as unknown as { name: string } & Partial<Socket>;
    const instance = pool.pick();
    const clientId = nextClientId++;
    const client = instance.addClient(clientId, data.name ?? 'Storm');

    data.clientId = clientId;
    data.instance = instance;
    data.client = client;
    sockets.set(clientId, ws);

    writer.reset();
    writeWelcome(writer, {
      version: 1,
      selfId: client.stormId,
      seed: instance.seed,
      worldW: WORLD_W,
      worldH: WORLD_H,
      tickRate: TICK_HZ,
      snapshotRate: SNAPSHOT_HZ,
      instance: instance.id,
    });
    ws.send(writer.bytes(), true);
    sendRoster(instance);
  },

  message: (ws, message) => {
    const data = ws.getUserData() as unknown as Socket;
    const client = data.client;
    if (client === undefined) return;

    metrics.bytesIn += message.byteLength;

    // Anything oversized is not a client this server speaks to.
    if (message.byteLength > 64) {
      flag(client, Flagged.PacketFlood);
      return;
    }
    if (!rateCheck(client, Date.now())) return;

    const bytes = new Uint8Array(message);
    const r = new Reader(bytes);
    const type = r.u8();

    if (type === Msg.Input) {
      const p = readInput(r);
      data.instance.applyInput(client, p.seq, p.steerAngle, p.boosting);
    } else if (type === Msg.Ping) {
      const t = r.u32();
      writer.reset();
      writer.u8(Msg.Pong);
      writer.u32(t);
      ws.send(writer.bytes(), true);
    } else if (type === Msg.Roster) {
      // The client reports its viewport so area of interest matches what it
      // can actually draw. Clamped: this is client-supplied and a huge view
      // would be a bandwidth amplification request.
      client.viewW = Math.min(4000, r.u16());
      client.viewH = Math.min(4000, r.u16());
    }
  },

  close: (ws) => {
    const data = ws.getUserData() as unknown as Socket;
    if (data.client === undefined) return;
    const inst = data.instance;
    const storm = inst.world.storms[data.client.stormId];

    // Every finished run stores seed + input log; Phase 14 re-sims it and
    // Phase 18 refuses to award points for a run without one.
    recordRun({
      clientId: data.client.id,
      name: data.client.name,
      instance: inst.id,
      seed: inst.seed,
      stormId: data.client.stormId,
      peakMass: storm?.stats.peakMass ?? 0,
      finalMass: storm?.mass ?? 0,
      durationMs: Date.now() - data.client.joinedAt,
      inputLog: data.client.inputLog,
      inputLogTruncated: data.client.inputLogTruncated,
      flags: data.client.flagged.slice(),
    });

    if (steeringLooksSynthetic(data.client.inputLog)) {
      flag(data.client, Flagged.QuantizedSteering);
    }

    sockets.delete(data.clientId);
    inst.removeClient(data.clientId);
    sendRoster(inst);
  },
});

// ---------------------------------------------------------------------------
// HTTP: health, region hints, and the Phase 17 dashboard's data feed
// ---------------------------------------------------------------------------

function json(res: uWS.HttpResponse, body: unknown): void {
  res.cork(() => {
    res
      .writeHeader('Content-Type', 'application/json')
      .writeHeader('Access-Control-Allow-Origin', '*')
      .end(JSON.stringify(body));
  });
}

app.get('/health', (res) => {
  json(res, {
    ok: true,
    region: REGION,
    instances: pool.instances.map((i) => i.stats()),
    humans: pool.totalHumans,
    avgStepMs: metrics.ticks > 0 ? metrics.stepMsSum / metrics.ticks : 0,
    peakStepMs: metrics.peakStepMs,
    // Reported so a soak can watch for drift without guessing at a pid.
    rssMb: process.memoryUsage().rss / 1048576,
    heapMb: process.memoryUsage().heapUsed / 1048576,
    uptimeSec: process.uptime(),
  });
});

app.get('/ping', (res) => {
  res.cork(() => res.writeHeader('Access-Control-Allow-Origin', '*').end('pong'));
});

// --- Phase 16-18: the economy, all read-only except the reward grant ------

app.get('/treasury', (res) => {
  res.cork(() => {
    res
      .writeHeader('Content-Type', 'text/html; charset=utf-8')
      .writeHeader('Access-Control-Allow-Origin', '*')
      .end(dashboardHtml());
  });
});

app.get('/api/treasury', (res) => json(res, dashboardJson()));
app.get('/api/token', (res) => json(res, publicState()));

app.get('/api/daily', (res) => {
  const seed = dailySeed();
  json(res, {
    seed,
    board: tournamentBoard(seed, replayValidator),
    freeEntry: true,
    note: 'Free entry. No stake, no wager - a promotion.',
  });
});

app.get('/api/epoch', (res) => {
  const name = epochName();
  json(res, settleEpoch(name, replayValidator));
});

app.get('/api/collusion', (res) => {
  // Observe-only. Scores are queryable; nothing acts on them yet.
  const now = Date.now();
  json(res, analyse(now - 7 * 86_400_000, now, epochName()));
});

app.get('/api/ads', (res) => {
  json(res, { network: adConfig.network, enabled: adConfig.enabled, placements: PLACEMENTS });
});

app.post('/api/reward', (res, req) => {
  const placement = req.getQuery('placement') as Placement;
  const account = req.getQuery('account') ?? '';
  const runId = req.getQuery('run') ?? '';
  res.onAborted(() => {});
  const grant = grantReward(account, placement, runId);
  if (grant.granted) recordImpression(placement);
  json(res, grant);
});

app.post('/api/revenue', (res, req) => {
  // Settled daily figures from the network's reporting API. Guarded by a
  // shared secret because it is the one input the buyback maths trusts.
  const secret = req.getHeader('x-sen-secret');
  const day = req.getQuery('day') ?? '';
  const netCents = Number(req.getQuery('netCents') ?? '0');
  const impressions = Number(req.getQuery('impressions') ?? '0');
  res.onAborted(() => {});
  // An unset secret closes the route rather than opening it: uWS returns ''
  // for a missing header, so comparing against a default of '' would let
  // anyone on the internet write the number the buyback maths is computed
  // from. Unconfigured means unavailable.
  const expected = process.env.SEN_REPORT_SECRET ?? '';
  if (expected === '') {
    res.writeStatus('503').end('revenue reporting not configured');
    return;
  }
  if (secret !== expected) {
    res.writeStatus('403').end('forbidden');
    return;
  }
  json(res, ingestNetworkReport(day, netCents, impressions));
});

app.post('/api/account', (res, req) => {
  const device = req.getQuery('device') ?? '';
  const email = req.getQuery('email') ?? '';
  const wallet = req.getQuery('wallet') ?? '';
  res.onAborted(() => {});
  if (device === '') {
    res.writeStatus('400').end('device required');
    return;
  }
  let acct = accountForDevice(device);
  if (email !== '') acct = upgradeAccount(device, email);
  // A wallet is linked only at claim time, and never gates play.
  if (wallet !== '') acct = linkWallet(acct.id, wallet) ?? acct;
  json(res, { id: acct.id, hasEmail: acct.email !== null, hasWallet: acct.wallet !== null,
    badges: acct.badges, runs: acct.runs, bestMass: acct.bestMass });
});

app.any('/*', (res) => {
  res.writeStatus('404').end('not found');
});

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------

/**
 * Who is in this instance.
 *
 * A connected human stays on the roster while dead: they are still in the
 * instance, they are still on the scoreboard, and dropping them the instant
 * they die is how a client ends up unable to name the storm that just ate it.
 * Bots are listed only while they are alive, since a dead bot is a slot, not
 * a participant.
 */
function rosterEntries(inst: Instance): { id: number; name: string; human: boolean }[] {
  const humanStorms = new Set<number>();
  for (const c of inst.clients.values()) humanStorms.add(c.stormId);
  const out: { id: number; name: string; human: boolean }[] = [];
  for (const s of inst.world.storms) {
    const human = humanStorms.has(s.id);
    if (!s.alive && !human) continue;
    out.push({ id: s.id, name: s.name, human });
  }
  return out;
}

/** Last roster composition sent per instance, so a resend costs nothing. */
const rosterSig = new Map<string, string>();

function sendRoster(inst: Instance): void {
  const entries = rosterEntries(inst);
  rosterSig.set(inst.id, entries.map((e) => `${e.id}:${e.human ? 1 : 0}:${e.name}`).join(','));
  writer.reset();
  writeRoster(writer, entries);
  const bytes = writer.bytes();
  for (const c of inst.clients.values()) {
    const ws = sockets.get(c.id);
    if (ws === undefined) continue;
    metrics.bytesOut += bytes.byteLength;
    ws.send(bytes, true);
  }
}

/**
 * Storms die and respawn constantly, so a roster sent only on join and leave
 * goes stale within seconds. Rebuild it once a second and put it on the wire
 * only when the composition actually changed - roughly 1KB, and almost never
 * on a settled instance.
 */
function rosterLoop(): void {
  for (const inst of pool.instances) {
    if (inst.clients.size === 0) continue;
    const sig = rosterEntries(inst)
      .map((e) => `${e.id}:${e.human ? 1 : 0}:${e.name}`)
      .join(',');
    if (sig === rosterSig.get(inst.id)) continue;
    sendRoster(inst);
  }
}

let accumulator = 0;
let last = process.hrtime.bigint();

function simLoop(): void {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accumulator += dt;

  let steps = 0;
  const t0 = process.hrtime.bigint();
  while (accumulator >= FIXED_DT && steps < 6) {
    pool.step();
    accumulator -= FIXED_DT;
    steps++;
    metrics.ticks++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (steps > 0) {
    metrics.stepMsSum += ms;
    if (ms / steps > metrics.peakStepMs) metrics.peakStepMs = ms / steps;
  }
}

function snapshotLoop(): void {
  for (const inst of pool.instances) {
    // Events are per-instance and shared by everyone in it.
    const events = inst.world.events
      .filter((e) => EVENT_ID[e.type] !== undefined)
      .map((e) => ({ type: EVENT_ID[e.type], storm: e.storm, x: e.x, y: e.y, a: e.a }));

    for (const c of inst.clients.values()) {
      const ws = sockets.get(c.id);
      if (ws === undefined) continue;

      const list = inst.entitiesFor(c, entityScratch);

      writer.reset();
      writeSnapshot(
        writer,
        {
          tick: inst.tick,
          ackSeq: c.lastSeq & 0xffff,
          baseTick: c.baseline === null ? 0 : c.baseTick,
          selfId: c.stormId,
        },
        list,
        c.baseline,
      );
      const bytes = writer.bytes();
      metrics.bytesOut += bytes.byteLength;
      metrics.snapshots++;
      ws.send(bytes, true);

      // The baseline advances optimistically. A dropped snapshot costs one
      // frame of staleness, not a desync, because the next delta is computed
      // against what we believe the client holds and a spawn mask resends
      // everything for anything it turns out not to have.
      const next = new Map<number, NetEntity>();
      for (const e of list) next.set(e.id, { ...e });
      c.baseline = next;
      c.baseTick = inst.tick;

      if (events.length > 0) {
        writer.reset();
        writeEvents(writer, events);
        const eb = writer.bytes();
        metrics.bytesOut += eb.byteLength;
        ws.send(eb, true);
      }
    }
  }
}

function reportLoop(): void {
  const now = Date.now();
  const secs = (now - metrics.lastReport) / 1000;
  if (secs <= 0) return;
  const down = metrics.bytesOut / secs / 1024;
  const up = metrics.bytesIn / secs / 1024;
  const humans = pool.totalHumans;
  const perClient = humans > 0 ? down / humans : 0;

  console.log(
    `[${REGION}] instances=${pool.instances.length} humans=${humans} ` +
      `tick=${(metrics.ticks / secs).toFixed(1)}Hz ` +
      `step=${(metrics.stepMsSum / Math.max(1, metrics.ticks)).toFixed(2)}ms ` +
      `peak=${metrics.peakStepMs.toFixed(2)}ms ` +
      `down=${down.toFixed(1)}KB/s (${perClient.toFixed(1)}/client) up=${up.toFixed(1)}KB/s ` +
      `rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`,
  );

  metrics.bytesOut = 0;
  metrics.bytesIn = 0;
  metrics.snapshots = 0;
  metrics.ticks = 0;
  metrics.stepMsSum = 0;
  metrics.peakStepMs = 0;
  metrics.lastReport = now;
  pool.reap();
}

/**
 * Phase 14's ground truth. Re-sims a stored run from seed + input log and
 * compares. Determinism from Brief 1 makes this nearly free, and it is what
 * every leaderboard and every airdrop point rests on.
 */
function replayValidator(r: { seed: number; inputLog: number[]; finalMass: number; stormId: number }): boolean {
  try {
    const check = validateReplay(() => resimulate(r), r.finalMass, 1e-6);
    return check.ok;
  } catch {
    return false;
  }
}

function resimulate(r: { seed: number; inputLog: number[]; stormId: number }): number {
  // A fresh world from the same seed, replaying the recorded inputs. Any
  // divergence - a doctored log, a patched client, a different build - lands
  // on a different final mass.
  const w = createWorld({ seed: r.seed, terrain, bots: TARGET_STORMS - 1 });
  const inputs = new Map<number, { steerAngle: number; boosting: boolean }>();
  const mine = { steerAngle: 0, boosting: false };
  inputs.set(r.stormId, mine);
  let cursor = 0;
  const lastTick = r.inputLog.length >= 3 ? r.inputLog[r.inputLog.length - 3] : 0;
  for (let tick = 0; tick <= lastTick; tick++) {
    while (cursor + 2 < r.inputLog.length && r.inputLog[cursor] <= tick) {
      mine.steerAngle = r.inputLog[cursor + 1];
      mine.boosting = r.inputLog[cursor + 2] === 1;
      cursor += 3;
    }
    step(w, inputs);
  }
  return w.storms[r.stormId]?.mass ?? -1;
}

// The buyback runs on a timer and nowhere else. There is no manual trigger.
setInterval(() => {
  void buybackTick().then((b) => {
    if (b !== null) console.log(`[buyback] #${b.id} ${b.status} ${b.spentCents}c`);
  });
}, 60_000);

setInterval(simLoop, 1000 / TICK_HZ);
setInterval(snapshotLoop, 1000 / SNAPSHOT_HZ);
setInterval(rosterLoop, 1000);
setInterval(reportLoop, 10_000);

app.listen(PORT, (token) => {
  if (token) {
    console.log(
      `super el nino server listening on :${PORT} region=${REGION} ` +
        `sim=${TICK_HZ}Hz snapshots=${SNAPSHOT_HZ}Hz ` +
        `cap=${MAX_HUMANS} humans, backfilled to ${TARGET_STORMS} storms`,
    );
  } else {
    console.error(`failed to bind :${PORT}`);
    process.exit(1);
  }
});
