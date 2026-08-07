/**
 * Generates the app icons: a spiral storm seen from orbit, eye off-centre,
 * sitting in a red sea bloom. Derived in code so the icon, the wordmark and
 * the in-game storm all come from the same geometry.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const DEEP = [0x0a, 0x14, 0x20];
const WARM = [0xc9, 0x43, 0x2b];
const STORM = [0x9a, 0xa6, 0xb8];
const LIT = [0xe4, 0xeb, 0xf2];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * @param maskable adds the safe-zone padding a maskable icon needs
 */
function draw(size, maskable) {
  const png = new PNG({ width: size, height: size });
  const d = png.data;
  const c = size / 2;
  // Maskable icons get clipped to a circle by the launcher, so shrink the art.
  const scale = maskable ? 0.62 : 0.84;
  // Eye off-centre - the logo should read as a system, not a target.
  const ex = c - size * 0.05;
  const ey = c - size * 0.04;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - ex) / (size * scale * 0.5);
      const dy = (y - ey) / (size * scale * 0.5);
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = Math.atan2(dy, dx);

      // The sea bloom underneath.
      let col = mix(DEEP, WARM, Math.max(0, 1 - r * 0.85) ** 1.6 * 0.92);

      // Spiral arms.
      if (r < 1) {
        const arms = 3;
        // Logarithmic spiral: phase advances with log radius.
        const phase = a - Math.log(Math.max(0.06, r)) * 1.35;
        const band = Math.cos(phase * arms);
        const strength = Math.max(0, band - 0.25) / 0.75;
        const falloff = Math.min(1, (1 - r) * 2.4) * Math.min(1, r * 5);
        col = mix(col, STORM, strength * falloff * 0.95);
        if (strength > 0.72) col = mix(col, LIT, falloff * 0.5);
      }

      // The eye.
      if (r < 0.13) col = mix(DEEP, col, Math.max(0, r / 0.13) ** 0.6);
      if (r > 0.115 && r < 0.15) col = mix(col, LIT, 0.55);

      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = 255;
    }
  }
  return png;
}

mkdirSync(new URL('../apps/client/public/icons/', import.meta.url), { recursive: true });

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['logo.png', 1024, false],
]) {
  const png = draw(size, maskable);
  writeFileSync(new URL(`../apps/client/public/icons/${name}`, import.meta.url), PNG.sync.write(png));
  console.log(`wrote public/icons/${name}`);
}
