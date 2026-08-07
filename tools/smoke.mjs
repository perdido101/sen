#!/usr/bin/env node
/**
 * Browser smoke test: boots the built game in Chromium, plays it for a while
 * with a scripted pointer, and reports console errors, FPS and screenshots.
 *
 *   node tools/smoke.mjs [outDir] [--seconds=N] [--mass=N]
 *
 * `--mass` force-feeds the player so the late game (ocean inversion, the warm
 * pool, the win sequence) can be seen without a 6-minute run.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-shots';
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m === undefined ? d : Number(m.split('=')[1]);
};
const SECONDS = arg('seconds', 12);
const FORCE_MASS = arg('mass', 0);
const WIDTH = arg('w', 900);
const HEIGHT = arg('h', 1600);
const PORT = arg('port', 4173);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  logs.push(text);
  if (m.type() === 'error') errors.push(text);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`http://localhost:${PORT}/?debug`, { waitUntil: 'load' });

// Wait for the menu, which only appears once the terrain has loaded.
await page.waitForSelector('.panel .wordmark', { timeout: 45000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/01-menu.png` });

// Turn on the debug overlay through the settings screen, exactly as a player
// would, so this exercises the real UI path.
await page.click('.panel[hidden="false"] .btn.ghost, .panel:not([hidden]) .row .btn.ghost:nth-child(2)').catch(() => {});
await page.waitForTimeout(200);

await page.evaluate(() => {
  const raw = localStorage.getItem('superelnino.save.v1');
  const s = raw ? JSON.parse(raw) : {};
  s.debug = true;
  s.sound = false;
  localStorage.setItem('superelnino.save.v1', JSON.stringify(s));
});
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.panel .wordmark', { timeout: 45000 });

await page.click('.btn.primary');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/02-early.png` });

// Steer in a slow circle so the storm actually feeds.
const cx = WIDTH / 2;
const cy = HEIGHT / 2;
const t0 = Date.now();
let shot = 3;
while ((Date.now() - t0) / 1000 < SECONDS) {
  const t = (Date.now() - t0) / 1000;
  const a = t * 0.7;
  await page.mouse.move(cx + Math.cos(a) * 260, cy + Math.sin(a) * 260);
  await page.waitForTimeout(60);
  if (t > shot * 4 - 1 && shot < 6) {
    await page.screenshot({ path: `${OUT}/0${shot}-run.png` });
    shot++;
  }
}
await page.screenshot({ path: `${OUT}/07-late.png` });

const debugText = await page.textContent('.debug').catch(() => null);

let forced = null;
if (FORCE_MASS > 0) {
  // Nudge the player's mass directly to inspect the endgame art. This reaches
  // into the running world on purpose - it is a diagnostic, not a cheat path
  // that exists in the shipped build.
  forced = await page.evaluate((mass) => {
    const g = window.__sen;
    if (g === undefined) return 'no hook';
    const w = g.world();
    const p = w.storms[w.playerId];
    // Revive as well as feed: a dead storm ignores mass entirely.
    p.alive = true;
    p.mass = mass;
    p.x = 3527;
    p.y = 2048;
    w.over = false;
    return `set mass ${mass} at the warm pool`;
  }, FORCE_MASS);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/08-endgame.png` });
}

await browser.close();

console.log(`screenshots -> ${OUT}`);
if (debugText !== null) console.log(`\n--- debug overlay ---\n${debugText}`);
if (forced !== null) console.log(`forced: ${forced}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors.');
