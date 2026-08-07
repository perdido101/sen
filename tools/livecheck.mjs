#!/usr/bin/env node
/**
 * Plays the deployed site, not a local build. A 200 on index.html proves
 * nothing: a subpath deploy that missed the base path returns 200 and then
 * dies on terrain.png, and the difference is only visible from a browser that
 * actually boots the game.
 *
 *   node tools/livecheck.mjs https://owner.github.io/repo/ [outDir]
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL_ = process.argv[2] ?? 'https://perdido101.github.io/sen/';
const OUT = process.argv[3] ?? '/tmp/sen-live';
mkdirSync(OUT, { recursive: true });

// Outbound HTTPS goes through the agent proxy; its CA is already in the
// browser's NSS store, so this needs routing, not trust weakening.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('requestfailed', (r) => failed.push(`${r.url()} (${r.failure()?.errorText})`));
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`${r.url()} -> HTTP ${r.status()}`);
});

console.log(`loading ${URL_}`);
await page.goto(`${URL_}?debug`, { waitUntil: 'load', timeout: 90000 });

let ok = true;
try {
  await page.waitForSelector('.panel .wordmark', { timeout: 90000 });
} catch {
  ok = false;
  errors.push('menu never appeared');
}
await page.screenshot({ path: `${OUT}/live-menu.png` });

if (ok) {
  await page.click('.panel:not([hidden]) .btn.primary');
  await page.waitForTimeout(6000);
  // Steer, so it is a real run and not a paused first frame.
  for (let i = 0; i < 24; i++) {
    const a = i * 0.28;
    await page.mouse.move(360 + Math.cos(a) * 220, 640 + Math.sin(a) * 220);
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: `${OUT}/live-play.png` });

  const state = await page.evaluate(() => {
    const g = window.__sen;
    if (g === undefined) return { hook: false };
    const w = g.world();
    const p = w.storms[w.playerId];
    let props = 0;
    for (const c of w.chunks.values()) for (const pr of c.props) if (pr.alive) props++;
    return {
      hook: true,
      terrain: `${w.terrain.w}x${w.terrain.h}`,
      tick: w.tick,
      mass: Math.round(p.mass),
      storms: w.storms.filter((s) => s.alive).length,
      chunks: w.chunks.size,
      props,
      stickmen: w.stickmen.filter((m) => m.active).length,
      cities: w.cities.length,
    };
  });
  console.log(JSON.stringify(state));

  // The terrain map is the thing a broken base path takes out, and a 0x0 map
  // makes the whole planet read as polar ice while still "running".
  if (!state.hook) errors.push('no debug hook - did the page really boot?');
  else {
    if (state.terrain !== '4096x2048') errors.push(`terrain is ${state.terrain}`);
    if (state.tick < 60) errors.push(`only ${state.tick} ticks simulated`);
    if (state.chunks === 0) errors.push('no chunks streamed');
    if (state.cities !== 120) errors.push(`${state.cities} cities`);
  }
}

await browser.close();

if (failed.length > 0) {
  console.error(`${failed.length} failed request(s):`);
  for (const f of failed.slice(0, 10)) console.error('  ' + f);
}
if (errors.length > 0 || failed.length > 0) {
  console.error('FAIL');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(`PASS: the deployed build boots and plays. Screenshots in ${OUT}`);
