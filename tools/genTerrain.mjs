/**
 * Generates public/terrain.png - the whole planet as one 4096x2048
 * equirectangular data map.
 *
 *   R  0 water, 128 land, 255 ice cap
 *   G  biome id: 0 ocean, 40 plains, 80 forest, 120 desert, 160 urban,
 *      200 mountain, 240 ice
 *   B  on land: elevation 0-255. On water: baseline sea surface temperature
 *      0-255 (equatorial Pacific warm pool peaks at 255).
 *
 * Continents are lat/lon polygons rasterised with a noise-perturbed test
 * point, which gives organic coastlines without any GIS pipeline. Run with:
 *   npm run gen:terrain
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { CITY_DATA } from '../packages/sim/src/data/cities.ts';
import { MAP_LON_ORIGIN, CITY_RADIUS, WORLD_W, WORLD_H } from '../packages/sim/src/sim/constants.ts';
import { valueNoise } from '../packages/sim/src/sim/rng.ts';

const W = 4096;
const H = 2048;
const SEED = 0x5e1c0de | 0;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function fbm(x, y, seed, octaves = 4) {
  let v = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += valueNoise(x * f, y * f, seed + i * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / norm;
}

/** Ridged noise, for mountain texture. */
function ridge(x, y, seed) {
  return 1 - Math.abs(fbm(x, y, seed, 3) * 2 - 1);
}

// ---------------------------------------------------------------------------
// Continents. Longitude first, latitude second. No polygon crosses +/-180;
// Antarctica is a latitude band instead.
// ---------------------------------------------------------------------------

const LANDMASSES = [
  // North America, including Alaska, Canada and Mexico
  [
    [-168, 65], [-165, 60], [-152, 59], [-145, 60], [-135, 57], [-130, 52],
    [-125, 48], [-124, 40], [-120, 34], [-114, 30], [-110, 24], [-105, 20],
    [-97, 16], [-92, 15], [-88, 16], [-88, 21], [-91, 25], [-95, 29],
    [-90, 29], [-84, 30], [-81, 25], [-80, 32], [-76, 35], [-74, 40],
    [-70, 43], [-66, 45], [-60, 47], [-56, 52], [-64, 58], [-78, 62],
    [-95, 60], [-95, 68], [-85, 70], [-95, 73], [-115, 73], [-130, 70],
    [-141, 70], [-156, 71], [-168, 66],
  ],
  // Greenland - the Mercator superpower. Keep it, badge it.
  [
    [-45, 60], [-52, 64], [-55, 70], [-60, 76], [-58, 82], [-40, 84],
    [-22, 80], [-20, 74], [-28, 68], [-42, 60],
  ],
  // South America
  [
    [-81, -4], [-79, 0], [-77, 8], [-71, 12], [-62, 10], [-52, 5], [-50, 0],
    [-44, -2], [-35, -5], [-38, -13], [-48, -25], [-53, -34], [-58, -38],
    [-62, -40], [-65, -45], [-68, -52], [-75, -52], [-73, -45], [-72, -35],
    [-70, -25], [-70, -18], [-76, -14], [-81, -6],
  ],
  // Africa
  [
    [-17, 15], [-16, 21], [-13, 28], [-9, 32], [-5, 36], [10, 37], [11, 33],
    [20, 32], [25, 32], [32, 31], [35, 28], [43, 12], [51, 12], [48, 5],
    [41, -2], [40, -10], [35, -18], [33, -26], [27, -34], [20, -35],
    [18, -33], [14, -23], [12, -16], [9, -1], [9, 4], [3, 6], [-5, 5],
    [-8, 4], [-13, 9],
  ],
  // Europe
  [
    [-10, 36], [-10, 44], [-2, 48], [2, 51], [8, 54], [11, 58], [18, 57],
    [22, 60], [28, 66], [32, 70], [40, 68], [45, 60], [45, 45], [40, 42],
    [28, 41], [24, 35], [19, 40], [13, 45], [3, 42], [-6, 36],
  ],
  // Northern Asia
  [
    [40, 68], [60, 70], [70, 73], [85, 75], [100, 77], [115, 74], [130, 73],
    [145, 72], [160, 70], [175, 68], [180, 65], [175, 62], [165, 60],
    [155, 52], [143, 48], [135, 44], [130, 42], [120, 45], [110, 45],
    [90, 45], [75, 45], [60, 45], [48, 45], [45, 55], [40, 60],
  ],
  // Central Asia
  [[50, 42], [70, 42], [85, 45], [92, 50], [70, 53], [55, 50], [48, 46]],
  // China
  [
    [100, 22], [110, 20], [118, 22], [122, 30], [122, 40], [126, 40],
    [128, 45], [120, 50], [110, 48], [100, 42], [95, 32], [97, 25],
  ],
  // India
  [
    [68, 24], [70, 20], [73, 16], [75, 8], [78, 8], [80, 13], [83, 18],
    [88, 21], [92, 22], [89, 26], [80, 30], [74, 32], [70, 28],
  ],
  // Indochina
  [[97, 20], [100, 20], [105, 20], [109, 11], [105, 9], [103, 1], [100, 6], [98, 10], [97, 16]],
  // Arabia
  [[35, 30], [43, 30], [48, 29], [56, 26], [59, 22], [52, 16], [45, 12], [43, 12], [38, 20], [34, 28]],
  // Iran / Anatolia bridge
  [[40, 32], [48, 30], [56, 26], [62, 25], [66, 26], [62, 36], [55, 40], [48, 40], [44, 38], [40, 36]],
  // Australia
  [
    [114, -22], [113, -26], [115, -34], [120, -34], [129, -32], [135, -35],
    [140, -38], [147, -38], [150, -37], [153, -28], [146, -19], [142, -11],
    [137, -12], [132, -11], [129, -15], [125, -14], [122, -18], [117, -20],
  ],
  [[131, -2], [141, -3], [150, -6], [147, -9], [140, -9], [133, -5]], // New Guinea
  [[172, -41], [174, -37], [178, -38], [176, -41]], // NZ north
  [[167, -46], [171, -42], [174, -45], [169, -47]], // NZ south
  [[130, 32], [135, 34], [140, 36], [142, 40], [141, 45], [145, 44], [139, 38], [135, 33], [131, 31]], // Japan
  [[-6, 50], [-5, 55], [-3, 58], [0, 54], [1, 52], [-4, 50]], // Britain
  [[-10, 52], [-10, 55], [-6, 55], [-6, 52]], // Ireland
  [[43, -12], [50, -15], [49, -25], [45, -25], [43, -20]], // Madagascar
  [[95, 5], [100, 0], [106, -6], [103, -6], [97, 2]], // Sumatra
  [[109, 2], [117, 4], [119, -1], [116, -4], [110, -3]], // Borneo
  [[105, -6], [114, -7], [115, -8], [106, -8]], // Java
  [[119, 1], [125, 1], [125, -5], [120, -5]], // Sulawesi
  [[120, 13], [124, 18], [126, 14], [126, 6], [122, 6], [120, 10]], // Philippines
  [[80, 6], [82, 7], [82, 9], [80, 9]], // Sri Lanka
  [[-85, 22], [-77, 23], [-74, 20], [-80, 21]], // Cuba
  [[-74, 18], [-68, 19], [-69, 18], [-73, 17]], // Hispaniola
  [[-24, 64], [-22, 66], [-14, 66], [-14, 64]], // Iceland
  [[120, 22], [122, 25], [121, 25], [120, 23]], // Taiwan
];

function pointInPoly(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Mountain ranges as polylines with a falloff width, in degrees.
// ---------------------------------------------------------------------------

const RANGES = [
  { w: 4.5, pts: [[70, 36], [76, 34], [84, 29], [92, 28], [97, 29]] }, // Himalaya
  { w: 3.5, pts: [[-70, 10], [-76, -5], [-71, -18], [-70, -30], [-72, -42], [-73, -50]] }, // Andes
  { w: 4.5, pts: [[-150, 62], [-135, 58], [-120, 50], [-112, 42], [-107, 35], [-105, 30]] }, // Rockies
  { w: 2.0, pts: [[6, 45], [11, 47], [15, 47]] }, // Alps
  { w: 2.0, pts: [[60, 68], [60, 58], [58, 52]] }, // Urals
  { w: 1.5, pts: [[40, 43], [46, 42]] }, // Caucasus
  { w: 1.8, pts: [[-8, 32], [0, 33], [8, 35]] }, // Atlas
  { w: 2.5, pts: [[36, 10], [40, 8]] }, // Ethiopian highlands
  { w: 2.0, pts: [[146, -20], [150, -30], [148, -37]] }, // Great Dividing
  { w: 2.0, pts: [[46, 34], [54, 29]] }, // Zagros
  { w: 2.0, pts: [[8, 60], [15, 66], [20, 69]] }, // Scandes
  { w: 2.5, pts: [[70, 42], [80, 42]] }, // Tien Shan
  { w: 1.5, pts: [[-84, 34], [-78, 40], [-72, 44]] }, // Appalachians
];

function segDist(lon, lat, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = lon - a[0];
  const wy = lat - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = lon - (a[0] + vx * t);
  const dy = lat - (a[1] + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function mountainScore(lon, lat) {
  let best = 0;
  for (const r of RANGES) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const d = segDist(lon, lat, r.pts[i], r.pts[i + 1]);
      if (d < r.w) {
        const s = 1 - d / r.w;
        if (s > best) best = s;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Desert regions - explicit boosts on top of the subtropical band.
// ---------------------------------------------------------------------------

const DESERTS = [
  { lon: 12, lat: 22, rx: 30, ry: 9, k: 1.0 }, // Sahara
  { lon: 46, lat: 22, rx: 12, ry: 8, k: 0.9 }, // Arabian
  { lon: 71, lat: 27, rx: 6, ry: 4, k: 0.7 }, // Thar
  { lon: 100, lat: 42, rx: 14, ry: 6, k: 0.8 }, // Gobi
  { lon: 80, lat: 40, rx: 8, ry: 4, k: 0.7 }, // Taklamakan
  { lon: 132, lat: -25, rx: 14, ry: 8, k: 0.9 }, // Australian interior
  { lon: 21, lat: -22, rx: 8, ry: 6, k: 0.8 }, // Kalahari / Namib
  { lon: -69, lat: -22, rx: 3, ry: 6, k: 0.9 }, // Atacama
  { lon: -113, lat: 34, rx: 8, ry: 5, k: 0.8 }, // Mojave / Sonora
  { lon: -69, lat: -45, rx: 5, ry: 5, k: 0.5 }, // Patagonia
];

function desertBoost(lon, lat) {
  let s = 0;
  for (const d of DESERTS) {
    const dx = (lon - d.lon) / d.rx;
    const dy = (lat - d.lat) / d.ry;
    const t = 1 - Math.sqrt(dx * dx + dy * dy);
    if (t > 0) s = Math.max(s, t * d.k);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Baseline sea surface temperature
// ---------------------------------------------------------------------------

function baselineSst(lon, lat) {
  // Latitudinal falloff: warm belt at the equator, near-freezing at the poles.
  let t = 235 * Math.exp(-((lat / 36) * (lat / 36)));

  // The equatorial Pacific warm pool - the hottest region on the map, and the
  // win arena. Peaks at 255.
  const dxRaw = ((lon - 175 + 540) % 360) - 180;
  const wx = dxRaw / 42;
  const wy = lat / 11;
  t += 90 * Math.exp(-(wx * wx + wy * wy));

  // Cold upwelling tongue off South America - gives the Pacific a shape.
  const cx = (((lon + 88 + 540) % 360) - 180) / 22;
  const cy = (lat + 7) / 9;
  t -= 55 * Math.exp(-(cx * cx + cy * cy));

  // Warm western boundary currents (Gulf Stream, Kuroshio) for flavour.
  const gx = (((lon + 55 + 540) % 360) - 180) / 20;
  const gy = (lat - 36) / 12;
  t += 30 * Math.exp(-(gx * gx + gy * gy));

  return t;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

const png = new PNG({ width: W, height: H });
const d = png.data;

console.log('rasterising planet...');

for (let py = 0; py < H; py++) {
  const lat = 90 - (py / H) * 180;
  for (let px = 0; px < W; px++) {
    const lon = (((px / W) * 360 + MAP_LON_ORIGIN + 180) % 360) - 180;

    // Noise-perturbed sample point gives organic coastlines from blunt
    // polygons. Two scales: a gentle coarse warp for bays and peninsulas, a
    // fine one for a ragged edge. Keep the coarse term small or continents
    // dissolve into amoebas.
    const n1 = fbm(lon * 0.28 + 100, lat * 0.28, SEED, 4);
    const n2 = fbm(lon * 0.28, lat * 0.28 + 100, SEED + 31, 4);
    const f1 = fbm(lon * 1.7 + 20, lat * 1.7, SEED + 5501, 3);
    const f2 = fbm(lon * 1.7, lat * 1.7 + 20, SEED + 8803, 3);
    const tLon = lon + (n1 - 0.5) * 1.5 + (f1 - 0.5) * 0.9;
    const tLat = lat + (n2 - 0.5) * 1.5 + (f2 - 0.5) * 0.9;

    let land = false;
    for (let i = 0; i < LANDMASSES.length; i++) {
      if (pointInPoly(tLon, tLat, LANDMASSES[i])) {
        land = true;
        break;
      }
    }

    // Antarctica: a latitude band rather than a polygon, so it never has to
    // cross the wrap seam.
    const antarcticEdge = -70 + (n1 - 0.5) * 5;
    if (lat < antarcticEdge) land = true;

    let r;
    let biomeG;
    let b;

    const arcticEdge = 80 + (n2 - 0.5) * 6;
    const isPolarIce = lat > arcticEdge || lat < antarcticEdge;
    // Greenland keeps an ice interior with a thin habitable coast.
    const greenlandIce = land && pointInPoly(lon, lat, LANDMASSES[1]) && lat > 68 && n1 > 0.35;

    if (isPolarIce || greenlandIce) {
      r = 255;
      biomeG = 240;
      b = Math.round(120 + n1 * 60);
    } else if (land) {
      r = 128;

      // Climate bands wander. Without this jitter every threshold below draws
      // a dead-straight line of latitude across the whole map, which is the
      // single most obvious tell that a world was generated.
      const bandJitter =
        (fbm(lon * 0.34 + 700, lat * 0.34, SEED + 1234, 3) - 0.5) * 11 +
        (fbm(lon * 1.1, lat * 1.1 + 700, SEED + 4321, 3) - 0.5) * 4;
      const alat = Math.abs(lat + bandJitter);
      const mtn = mountainScore(lon, lat);
      const dry = fbm(lon * 0.6 + 400, lat * 0.6, SEED + 77, 4);
      const wet = fbm(lon * 0.5, lat * 0.5 + 400, SEED + 909, 4);

      // Elevation: broad continental swell plus ridged mountain texture.
      const elev = Math.min(
        255,
        20 + fbm(lon * 0.22, lat * 0.22, SEED + 5, 5) * 70 + mtn * (140 + ridge(lon * 1.4, lat * 1.4, SEED + 12) * 90),
      );
      b = Math.round(elev);

      // Subtropical dry belt as a smooth falloff around 24 degrees rather than
      // a hard window, so the Sahel fades in instead of switching on.
      const beltT = Math.max(0, 1 - Math.abs(alat - 24) / 11);
      const desert = desertBoost(lon, lat) + beltT * 0.42 + (dry - 0.5) * 0.55;
      const boreal = alat > 47 && alat < 68;
      const tropical = alat < 13;

      if (mtn > 0.3 || elev > 150) biomeG = 200;
      else if (desert > 0.45) biomeG = 120;
      else if (boreal && wet > 0.38) biomeG = 80;
      else if (tropical && wet > 0.42) biomeG = 80;
      else if (wet > 0.66) biomeG = 80;
      else biomeG = 40;
    } else {
      r = 0;
      biomeG = 0;
      const sst = baselineSst(lon, lat) + (n1 - 0.5) * 14;
      b = Math.round(Math.max(0, Math.min(255, sst)));
    }

    const i = (py * W + px) * 4;
    d[i] = r;
    d[i + 1] = biomeG;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  if (py % 256 === 0) console.log(`  row ${py}/${H}`);
}

// ---------------------------------------------------------------------------
// Paint cities: force land underneath and stamp the urban biome.
// ---------------------------------------------------------------------------

console.log('stamping cities...');

const PX_PER_WORLD = W / WORLD_W;

for (const c of CITY_DATA) {
  const worldX = (((c.lon - MAP_LON_ORIGIN + 360) % 360) / 360) * WORLD_W;
  const worldY = ((90 - c.lat) / 180) * WORLD_H;
  const cx = Math.round(worldX * PX_PER_WORLD);
  const cy = Math.round(worldY * (H / WORLD_H));
  // Only the dense core gets stamped urban. The gameplay city radius is much
  // wider than its built-up footprint - the -35% drain slowdown comes from the
  // city state, not from the biome.
  const rad = Math.round(CITY_RADIUS[c.t] * PX_PER_WORLD * 0.34);

  for (let dy = -rad; dy <= rad; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= H) continue;
    for (let dx = -rad; dx <= rad; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy) / rad;
      if (dist > 1) continue;
      const px = (((cx + dx) % W) + W) % W;
      const i = (py * W + px) * 4;
      // Ragged edge so cities do not read as perfect discs from above.
      const edge = fbm(px * 0.06, py * 0.06, SEED + 4242, 3);
      if (dist > 0.55 + edge * 0.5) continue;
      d[i] = 128;
      d[i + 1] = 160;
      if (d[i + 2] < 30) d[i + 2] = 40;
    }
  }
}

mkdirSync(new URL('../apps/client/public/', import.meta.url), { recursive: true });
const out = new URL('../apps/client/public/terrain.png', import.meta.url);
writeFileSync(out, PNG.sync.write(png, { colorType: 6 }));

// Quick sanity report.
let water = 0;
let ice = 0;
let landPx = 0;
for (let i = 0; i < d.length; i += 4) {
  if (d[i] < 64) water++;
  else if (d[i] > 192) ice++;
  else landPx++;
}
const total = W * H;
console.log(
  `wrote public/terrain.png  water ${(water / total * 100).toFixed(1)}%  land ${(landPx / total * 100).toFixed(1)}%  ice ${(ice / total * 100).toFixed(1)}%`,
);
