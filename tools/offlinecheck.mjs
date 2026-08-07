#!/usr/bin/env node
/**
 * PHASE 9 ACCEPTANCE
 *
 * Loads the built game once, waits for the service worker to precache, then
 * kills the network entirely and reloads. There is no server behind this game,
 * so it should play on a plane.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-offline';
const PORT = 4173;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 720, height: 1280 } });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForSelector('.panel .wordmark', { timeout: 60000 });

// Wait for the worker to take control and finish precaching.
const swReady = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.ready;
  return reg.active ? 'active' : 'no-active-worker';
});
console.log(`service worker: ${swReady}`);
if (swReady !== 'active') {
  console.error('FAIL: no active service worker, offline play is impossible');
  await browser.close();
  process.exit(1);
}

// Give the precache a moment to settle, then cut the wire.
await page.waitForTimeout(6000);
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  let total = 0;
  const perCache = {};
  for (const n of names) {
    const c = await caches.open(n);
    const keys = await c.keys();
    perCache[n] = keys.length;
    total += keys.length;
  }
  // Workbox precaches with a __WB_REVISION__ query, so an exact-URL match
  // misses it and would report a false negative.
  const terrain = await caches.match('/terrain.png', { ignoreSearch: true });
  return { names, total, perCache, hasTerrain: terrain !== undefined };
});
console.log(`precached: ${cached.total} entries ${JSON.stringify(cached.perCache)}`);
console.log(`terrain.png cached: ${cached.hasTerrain}`);
if (!cached.hasTerrain) {
  console.error('FAIL: the one asset the game cannot start without is not precached');
  await browser.close();
  process.exit(1);
}

await ctx.setOffline(true);
await page.reload({ waitUntil: 'load' });

let ok = true;
try {
  await page.waitForSelector('.panel .wordmark', { timeout: 45000 });
} catch {
  ok = false;
}
await page.screenshot({ path: `${OUT}/offline-menu.png` });

if (ok) {
  // Not just the shell - it has to actually start a run with no network.
  await page.click('.panel:not([hidden]) .btn.primary');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/offline-play.png` });
  const playing = await page.evaluate(
    () => document.querySelector('.hud') !== null && !document.querySelector('.hud').hidden,
  );
  if (!playing) {
    ok = false;
    errors.push('offline: HUD never appeared, the run did not start');
  }
}

await browser.close();

if (!ok || errors.length > 0) {
  console.error('FAIL: offline play broken');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('PASS: menu and a live run both work in airplane mode.');
