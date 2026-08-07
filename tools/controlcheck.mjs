#!/usr/bin/env node
/**
 * Controls check.
 *
 * Asserts the three schemes actually move the storm, and that the touch pads
 * appear on a phone and nowhere near a desktop. Steering is the one thing a
 * screenshot cannot verify - it has to be measured as a change in heading.
 */

import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/sen-controls';
const PORT = Number(process.env.SEN_PORT ?? 4173);
const BASE = process.env.SEN_BASE ?? '/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SEN_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'],
});

const problems = [];
const url = `http://localhost:${PORT}${BASE}?debug`;

const heading = (page) =>
  page.evaluate(() => {
    const w = window.__sen.world();
    return w.storms[w.playerId].ang;
  });

/**
 * Keep the storm alive for the duration of the measurement. A fresh Dust
 * Devil can dissipate mid-test, and a dead storm's heading simply stops
 * changing - which reads as "the key does nothing".
 */
const revive = (page, ang) =>
  page.evaluate((a) => {
    const w = window.__sen.world();
    const p = w.storms[w.playerId];
    p.alive = true;
    p.mass = Math.max(p.mass, 60);
    w.over = false;
    // Start each measurement from a known heading roughly a quarter turn from
    // the expected target, so "it already happened to point that way" cannot
    // pass or fail the check by accident.
    if (a !== null) p.ang = a;
    return p.ang;
  }, ang);

/** Shortest angular distance, so the +/-PI seam does not read as a huge turn. */
function turned(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

async function startRun(page) {
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForSelector('.panel .wordmark', { timeout: 90000 });
  await page.click('.panel:not([hidden]) .btn.primary');
  await page.waitForTimeout(1500);
}

// --------------------------------------------------------------- desktop
{
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.on('pageerror', (e) => problems.push(`desktop pageerror: ${e.message}`));
  await startRun(page);

  const padsVisible = await page.evaluate(() => {
    const t = document.querySelector('.touch');
    return t !== null && !t.hidden;
  });
  if (padsVisible) problems.push('touch pads are showing on a desktop pointer');

  // Park the mouse so pointer steering is not fighting the keys, then hold a
  // key long enough for a big storm to actually come round.
  await page.mouse.move(550, 350);
  const cases = [
    ['KeyW', 'W', 0, -Math.PI / 2],
    ['ArrowRight', 'ArrowRight', -Math.PI / 2, 0],
    ['KeyA', 'A', -Math.PI / 2, Math.PI],
  ];
  for (const [key, label, from, want] of cases) {
    await revive(page, from);
    const before = await heading(page);
    await page.keyboard.down(key);
    await page.waitForTimeout(2200);
    await page.keyboard.up(key);
    const after = await heading(page);
    if (turned(before, after) < 0.25) {
      problems.push(`${label} did not turn the storm (${before.toFixed(2)} -> ${after.toFixed(2)})`);
    } else if (turned(after, want) > 0.35) {
      problems.push(
        `${label} steered to ${after.toFixed(2)}, expected about ${want.toFixed(2)}`,
      );
    }
  }
  await page.screenshot({ path: `${OUT}/desktop.png` });
  await page.close();
}

// ----------------------------------------------------------------- phone
{
  const iphone = devices['iPhone 13'];
  const ctx = await browser.newContext({ ...iphone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`phone pageerror: ${e.message}`));
  await startRun(page);

  const pads = await page.evaluate(() => {
    const t = document.querySelector('.touch');
    if (t === null || t.hidden) return null;
    const base = document.querySelector('.stick-base').getBoundingClientRect();
    const boost = document.querySelector('.boost-btn').getBoundingClientRect();
    return {
      w: innerWidth,
      h: innerHeight,
      stick: { x: base.x + base.width / 2, y: base.y + base.height / 2 },
      boost: { x: boost.x + boost.width / 2, y: boost.y + boost.height / 2 },
    };
  });

  if (pads === null) {
    problems.push('touch pads are missing on a phone');
  } else {
    // The stick belongs in the bottom-right corner, the boost pad opposite.
    if (pads.stick.x < pads.w * 0.5) problems.push('stick is not on the right');
    if (pads.stick.y < pads.h * 0.5) problems.push('stick is not near the bottom');
    if (pads.boost.x > pads.w * 0.5) problems.push('boost pad is not on the left');

    // Drag the stick and check the storm follows. Touch has to be dispatched
    // as a real pointer sequence: page.mouse would be a fine pointer and the
    // stick deliberately ignores those.
    // Face east, then pull the stick west: the storm has half a turn to make.
    await revive(page, 0);
    const before = await heading(page);
    const cdp = await ctx.newCDPSession(page);
    const touch = async (type, x, y) => {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
      });
    };
    await touch('touchStart', pads.stick.x, pads.stick.y);
    // Pull left: the storm should come round to a westward heading.
    await touch('touchMove', pads.stick.x - 60, pads.stick.y);
    await page.waitForTimeout(1000);
    await revive(page, null);
    await page.waitForTimeout(1600);
    const after = await heading(page);
    await touch('touchEnd', 0, 0);

    if (turned(before, after) < 0.25) {
      problems.push(`stick did not steer (${before.toFixed(2)} -> ${after.toFixed(2)})`);
    } else if (turned(after, Math.PI) > 0.4) {
      problems.push(`stick steered to ${after.toFixed(2)}, expected about west`);
    }
    await page.screenshot({ path: `${OUT}/phone.png` });
  }
  await page.close();
  await ctx.close();
}

await browser.close();

if (problems.length > 0) {
  console.error(`${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`controls OK - screenshots in ${OUT}`);
