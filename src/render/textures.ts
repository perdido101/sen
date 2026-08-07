/**
 * Every sprite in the game is drawn in code and baked to a texture once at
 * boot. No asset pipeline, no download, and the whole thing plays offline on
 * first load.
 *
 * Style rules, applied uniformly (§6): top-down orthographic, flat lighting,
 * no gradients, chunky dark outline, palette restricted, transparent
 * background.
 */

import { Container, Graphics, Renderer, Texture } from 'pixi.js';
import { C, SHIRTS, shade } from './palette.ts';
import { PROP_KINDS } from '../sim/props.ts';

const INK = C.ink;
const LINE = 3;

function tex(renderer: Renderer, g: Container, res = 2): Texture {
  const t = renderer.generateTexture({ target: g, resolution: res, antialias: true });
  g.destroy(true);
  return t;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

function leafyTree(r: number, color: number): Graphics {
  const g = new Graphics();
  // Top-down canopy: a blobby ring of lobes with a trunk dot.
  const lobes = 7;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    g.circle(Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, r * 0.5);
  }
  g.fill(color).stroke({ width: LINE, color: INK, alignment: 0.5 });
  g.circle(0, 0, r * 0.5).fill(shade(color, 1.18));
  g.circle(0, 0, r * 0.14).fill(shade(color, 0.55));
  return g;
}

function pineTree(r: number): Graphics {
  const g = new Graphics();
  const spikes = 9;
  g.moveTo(r, 0);
  for (let i = 1; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.56;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath().fill(0x467a3c).stroke({ width: LINE, color: INK });
  g.circle(0, 0, r * 0.34).fill(0x6aa85a);
  return g;
}

function rock(r: number): Graphics {
  const g = new Graphics();
  const n = 6;
  g.moveTo(r, 0);
  for (let i = 1; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.72 + ((i * 37) % 11) / 36);
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath().fill(C.mountain).stroke({ width: LINE, color: INK });
  g.moveTo(-r * 0.3, -r * 0.2).lineTo(r * 0.1, r * 0.35).stroke({ width: 2, color: shade(C.mountain, 0.7) });
  return g;
}

function box(w: number, h: number, fill: number, roof?: number): Graphics {
  const g = new Graphics();
  // Fake-3D offset shadow so height reads from directly above.
  g.rect(-w / 2 + 3, -h / 2 + 4, w, h).fill({ color: INK, alpha: 0.35 });
  g.rect(-w / 2, -h / 2, w, h).fill(fill).stroke({ width: LINE, color: INK });
  if (roof !== undefined) {
    g.rect(-w / 2 + w * 0.18, -h / 2 + h * 0.18, w * 0.64, h * 0.64).fill(roof);
  }
  return g;
}

function car(r: number): Graphics {
  const g = new Graphics();
  const w = r * 1.05;
  const h = r * 1.8;
  g.roundRect(-w / 2 + 2, -h / 2 + 3, w, h, 4).fill({ color: INK, alpha: 0.3 });
  g.roundRect(-w / 2, -h / 2, w, h, 4).fill(0xd8563f).stroke({ width: LINE, color: INK });
  // Windscreen and rear glass, seen from above.
  g.roundRect(-w * 0.34, -h * 0.3, w * 0.68, h * 0.24, 2).fill(0x2c3a4a);
  g.roundRect(-w * 0.34, h * 0.06, w * 0.68, h * 0.2, 2).fill(0x2c3a4a);
  return g;
}

function cow(r: number): Graphics {
  const g = new Graphics();
  g.ellipse(2, 3, r * 0.62, r * 0.9).fill({ color: INK, alpha: 0.3 });
  g.ellipse(0, 0, r * 0.62, r * 0.9).fill(0xf2f2ee).stroke({ width: LINE, color: INK });
  g.ellipse(-r * 0.2, -r * 0.2, r * 0.26, r * 0.3).fill(0x2a2f36);
  g.ellipse(r * 0.22, r * 0.3, r * 0.2, r * 0.26).fill(0x2a2f36);
  g.circle(0, -r * 0.82, r * 0.3).fill(0xf2f2ee).stroke({ width: 2, color: INK });
  return g;
}

function fence(r: number): Graphics {
  const g = new Graphics();
  g.rect(-r, -2, r * 2, 4).fill(0x8a6a44).stroke({ width: 2, color: INK });
  for (let i = -1; i <= 1; i++) {
    g.rect(i * r * 0.7 - 2, -r * 0.4, 4, r * 0.8).fill(0x8a6a44).stroke({ width: 2, color: INK });
  }
  return g;
}

function windmill(r: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r * 0.28).fill(0xe8ecf0).stroke({ width: LINE, color: INK });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    g.moveTo(0, 0)
      .lineTo(Math.cos(a) * r, Math.sin(a) * r)
      .stroke({ width: 5, color: 0xe8ecf0 });
    g.moveTo(0, 0)
      .lineTo(Math.cos(a) * r, Math.sin(a) * r)
      .stroke({ width: 1.5, color: INK });
  }
  g.circle(0, 0, r * 0.16).fill(INK);
  return g;
}

function waterTower(r: number): Graphics {
  const g = new Graphics();
  g.circle(3, 4, r * 0.8).fill({ color: INK, alpha: 0.32 });
  g.circle(0, 0, r * 0.8).fill(0xa8b4c0).stroke({ width: LINE, color: INK });
  g.circle(0, 0, r * 0.4).fill(0x7f8b98);
  return g;
}

function cactus(r: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r * 0.42).fill(0x4e8a4a).stroke({ width: LINE, color: INK });
  g.circle(-r * 0.6, 0, r * 0.26).fill(0x4e8a4a).stroke({ width: 2.5, color: INK });
  g.circle(r * 0.55, -r * 0.3, r * 0.24).fill(0x4e8a4a).stroke({ width: 2.5, color: INK });
  return g;
}

function ship(len: number, wid: number, hull: number, deck: number): Graphics {
  const g = new Graphics();
  const drawHull = (ox: number, oy: number, col: number, alpha: number) => {
    g.moveTo(ox, oy - len / 2)
      .lineTo(ox + wid / 2, oy - len * 0.24)
      .lineTo(ox + wid / 2, oy + len / 2)
      .lineTo(ox - wid / 2, oy + len / 2)
      .lineTo(ox - wid / 2, oy - len * 0.24)
      .closePath()
      .fill({ color: col, alpha });
  };
  drawHull(2, 4, INK, 0.35);
  drawHull(0, 0, hull, 1);
  g.stroke({ width: LINE, color: INK });
  g.rect(-wid * 0.3, -len * 0.16, wid * 0.6, len * 0.5).fill(deck);
  g.rect(-wid * 0.34, len * 0.22, wid * 0.68, len * 0.18).fill(0xe8ecf0).stroke({ width: 2, color: INK });
  return g;
}

function oilPlatform(r: number): Graphics {
  const g = new Graphics();
  g.rect(-r + 3, -r + 4, r * 2, r * 2).fill({ color: INK, alpha: 0.32 });
  g.rect(-r, -r, r * 2, r * 2).fill(0xc8a23a).stroke({ width: LINE, color: INK });
  g.rect(-r * 0.5, -r * 0.5, r, r).fill(0x8a8477);
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.circle(x * r * 0.72, y * r * 0.72, r * 0.16).fill(INK);
  }
  return g;
}

function buoy(r: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r).fill(C.siren).stroke({ width: 2.5, color: INK });
  g.circle(0, 0, r * 0.42).fill(0xe8ecf0);
  return g;
}

function island(r: number, palm: boolean): Graphics {
  const g = new Graphics();
  const n = 9;
  g.moveTo(r, 0);
  for (let i = 1; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.74 + ((i * 53) % 13) / 46);
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath().fill(0xe6d3a3).stroke({ width: LINE, color: INK });
  g.circle(0, 0, r * 0.52).fill(palm ? 0x4e8a4a : C.plains);
  if (palm) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.moveTo(0, 0).lineTo(Math.cos(a) * r * 0.46, Math.sin(a) * r * 0.46).stroke({ width: 3, color: 0x2f6b34 });
    }
  }
  return g;
}

function haybale(r: number): Graphics {
  const g = new Graphics();
  g.circle(2, 3, r).fill({ color: INK, alpha: 0.3 });
  g.circle(0, 0, r).fill(0xd8c27a).stroke({ width: LINE, color: INK });
  g.circle(0, 0, r * 0.5).fill(0xc0a95f);
  return g;
}

function signpost(r: number): Graphics {
  const g = new Graphics();
  g.rect(-r * 0.7, -r * 0.4, r * 1.4, r * 0.7).fill(0x3f7fd8).stroke({ width: 2.5, color: INK });
  g.rect(-2, -r * 0.4, 4, r * 0.9).fill(0x6e6a72).stroke({ width: 2, color: INK });
  return g;
}

/** Top-down airliner: fuselage, swept wings, tailplane. */
function plane(r: number, body: number, wing: number): Graphics {
  const g = new Graphics();
  const L = r * 2;
  const W = r * 1.7;
  // Wings first, so the fuselage reads on top of them.
  g.moveTo(0, -L * 0.06)
    .lineTo(-W / 2, L * 0.22)
    .lineTo(-W / 2, L * 0.32)
    .lineTo(0, L * 0.12)
    .lineTo(W / 2, L * 0.32)
    .lineTo(W / 2, L * 0.22)
    .closePath()
    .fill(wing)
    .stroke({ width: 2.5, color: INK });
  // Tailplane.
  g.moveTo(0, L * 0.3)
    .lineTo(-W * 0.22, L * 0.46)
    .lineTo(-W * 0.22, L * 0.5)
    .lineTo(W * 0.22, L * 0.5)
    .lineTo(W * 0.22, L * 0.46)
    .closePath()
    .fill(wing)
    .stroke({ width: 2, color: INK });
  // Fuselage.
  g.moveTo(0, -L / 2)
    .lineTo(r * 0.26, -L * 0.24)
    .lineTo(r * 0.26, L * 0.46)
    .lineTo(-r * 0.26, L * 0.46)
    .lineTo(-r * 0.26, -L * 0.24)
    .closePath()
    .fill(body)
    .stroke({ width: 2.5, color: INK });
  g.circle(0, -L * 0.28, r * 0.14).fill(0x2c3a4a);
  return g;
}

function propGraphic(name: string, r: number): Graphics {
  switch (name) {
    case 'tree': return leafyTree(r, 0x5c9450);
    case 'pine': return pineTree(r);
    case 'bush': return leafyTree(r, 0x93bd6c);
    case 'rock': return rock(r);
    case 'fence': return fence(r);
    case 'barn': return box(r * 1.5, r * 1.9, 0xa8452f, 0x8a3626);
    case 'car': return car(r);
    case 'watertower': return waterTower(r);
    case 'cow': return cow(r);
    case 'windmill': return windmill(r);
    case 'cactus': return cactus(r);
    case 'house': return box(r * 1.5, r * 1.5, 0xb0a89a, 0x8f6a4f);
    case 'haybale': return haybale(r);
    case 'signpost': return signpost(r);
    case 'containership': return ship(r * 2.1, r * 0.78, 0x2f5f8a, 0xd8563f);
    case 'tanker': return ship(r * 2.2, r * 0.86, 0x3a3f48, 0xc8a23a);
    case 'oilplatform': return oilPlatform(r * 0.9);
    case 'fishingboat': return ship(r * 1.7, r * 0.8, 0x4e8a8a, 0xe8ecf0);
    case 'buoy': return buoy(r * 0.8);
    case 'island': return island(r, false);
    case 'palmislet': return island(r, true);
    case 'airliner': return plane(r, 0xe8ecf0, 0xb8c0c8);
    case 'cargoplane': return plane(r, 0xc8a23a, 0x9aa0a8);
    default: return box(r, r, C.storm);
  }
}

// ---------------------------------------------------------------------------
// Debris - the field. Tumbling mid-air, so they read as thrown, not placed.
// ---------------------------------------------------------------------------

const DEBRIS_DRAW: ((g: Graphics, r: number) => void)[] = [
  // 0 car
  (g, r) => {
    g.roundRect(-r * 0.5, -r, r, r * 2, 3).fill(0xd8563f).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.34, -r * 0.5, r * 0.68, r * 0.5).fill(0x2c3a4a);
  },
  // 1 roof panel
  (g, r) => {
    g.moveTo(-r, -r * 0.7).lineTo(r, -r * 0.4).lineTo(r * 0.8, r * 0.8).lineTo(-r * 0.9, r * 0.6)
      .closePath().fill(0x8f6a4f).stroke({ width: 2.5, color: INK });
    g.moveTo(-r * 0.6, -r * 0.6).lineTo(-r * 0.4, r * 0.66).stroke({ width: 2, color: shade(0x8f6a4f, 0.7) });
  },
  // 2 tree
  (g, r) => {
    g.circle(0, -r * 0.2, r * 0.72).fill(C.forest).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.14, r * 0.2, r * 0.28, r * 0.8).fill(0x6b4a2c).stroke({ width: 2, color: INK });
  },
  // 3 billboard
  (g, r) => {
    g.rect(-r, -r * 0.62, r * 2, r * 1.24).fill(0xe8ecf0).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.8, -r * 0.42, r * 1.6, r * 0.4).fill(C.siren);
    g.rect(-r * 0.8, r * 0.06, r * 1.1, r * 0.3).fill(C.coolSea);
  },
  // 4 boat
  (g, r) => {
    g.moveTo(0, -r).lineTo(r * 0.62, r * 0.3).lineTo(0, r).lineTo(-r * 0.62, r * 0.3)
      .closePath().fill(0x2f5f8a).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.3, -r * 0.2, r * 0.6, r * 0.6).fill(0xe8ecf0);
  },
  // 5 generic dirt / rubble
  (g, r) => {
    g.moveTo(r, 0).lineTo(r * 0.3, r * 0.9).lineTo(-r * 0.8, r * 0.5)
      .lineTo(-r * 0.7, -r * 0.5).lineTo(r * 0.2, -r * 0.9)
      .closePath().fill(C.debris).stroke({ width: 2.5, color: INK });
  },
  // 6 sign
  (g, r) => {
    g.circle(0, 0, r * 0.8).fill(C.siren).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.55, -r * 0.14, r * 1.1, r * 0.28).fill(0xe8ecf0);
  },
  // 7 cow
  (g, r) => {
    g.ellipse(0, 0, r * 0.6, r * 0.85).fill(0xf2f2ee).stroke({ width: 2.5, color: INK });
    g.ellipse(-r * 0.18, -r * 0.2, r * 0.24, r * 0.28).fill(0x2a2f36);
  },
  // 8 shopping cart
  (g, r) => {
    g.rect(-r * 0.7, -r * 0.5, r * 1.4, r).fill(0xb8c0c8).stroke({ width: 2.5, color: INK });
    for (let i = -1; i <= 1; i++) g.moveTo(i * r * 0.35, -r * 0.5).lineTo(i * r * 0.35, r * 0.5).stroke({ width: 1.5, color: INK });
  },
  // 9 deck chair
  (g, r) => {
    g.rect(-r * 0.6, -r * 0.8, r * 1.2, r * 1.6).fill(0xd8b83f).stroke({ width: 2.5, color: INK });
    g.rect(-r * 0.6, -r * 0.2, r * 1.2, r * 0.25).fill(0xe8ecf0);
  },
];

// ---------------------------------------------------------------------------
// Buildings - top-down footprints with a fake-3D offset shadow.
// ---------------------------------------------------------------------------

const BUILDING_COLORS = [
  [0xb0a89a, 0x8f6a4f], // house
  [0x9aa0a8, 0x6e6a72], // apartment
  [0xa8b4c0, 0x7f8b98], // office
  [0xd6cdbb, 0xa8452f], // church
  [0x8a8f96, 0x5c6068], // factory
  [0xc0c6cc, 0x3f7fd8], // tower
  [0xb8bec6, 0x4e8a4a], // stadium
];

function buildingTex(renderer: Renderer, kind: number, dmg: number): Texture {
  const g = new Graphics();
  const S = 48;
  const [wall, roof] = BUILDING_COLORS[kind % BUILDING_COLORS.length];
  if (dmg === 0) {
    const lift = 3 + kind;
    g.rect(-S / 2 + lift, -S / 2 + lift * 1.3, S, S).fill({ color: INK, alpha: 0.4 });
    g.rect(-S / 2, -S / 2, S, S).fill(wall).stroke({ width: LINE, color: INK });
    g.rect(-S * 0.3, -S * 0.3, S * 0.6, S * 0.6).fill(roof);
    // Rooftop clutter so the silhouette is not a plain square.
    g.rect(-S * 0.22, -S * 0.42, S * 0.18, S * 0.14).fill(shade(wall, 0.8));
    g.circle(S * 0.24, S * 0.22, S * 0.09).fill(shade(wall, 0.8));
  } else if (dmg === 1) {
    g.rect(-S / 2 + 2, -S / 2 + 2, S, S).fill({ color: INK, alpha: 0.28 });
    g.rect(-S / 2, -S / 2, S, S).fill(shade(wall, 0.82)).stroke({ width: LINE, color: INK });
    g.moveTo(-S * 0.4, -S * 0.1).lineTo(S * 0.1, S * 0.4).lineTo(S * 0.4, -S * 0.2)
      .closePath().fill(shade(wall, 0.6));
  } else {
    // Rubble.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const rr = S * 0.2;
      g.rect(Math.cos(a) * S * 0.24 - rr / 2, Math.sin(a) * S * 0.24 - rr / 2, rr, rr * 0.8)
        .fill(shade(wall, 0.55 + (i % 3) * 0.08));
    }
    g.stroke({ width: 2, color: INK });
  }
  return tex(renderer, g, 1.5);
}

// ---------------------------------------------------------------------------
// Stickmen. Drawn procedurally - circle head, four line segments - and baked
// into a small pose atlas so hundreds can be on screen at 60fps.
// ---------------------------------------------------------------------------

export const MAN_POSES = 10;
const MAN_H = 26;

/**
 * @param pose 0-3 walk cycle, 4 arms-up alert, 5-7 flee, 8-9 flail
 */
function stickmanGraphic(pose: number, shirt: number, hat: boolean, bike: boolean, camera: boolean): Graphics {
  const g = new Graphics();
  const h = MAN_H;
  const headR = h * 0.2;
  const bodyTop = -h * 0.28;
  const bodyBot = h * 0.2;
  const lw = 3;

  let armA = 0.9;
  let armB = -0.9;
  let legA = 0.45;
  let legB = -0.45;
  let bob = 0;

  if (pose < 4) {
    // Two-frame walk bob, doubled for a smoother cycle.
    const t = pose / 4;
    legA = Math.sin(t * Math.PI * 2) * 0.6;
    legB = -legA;
    armA = -legA * 0.7;
    armB = -armA;
    bob = Math.abs(Math.sin(t * Math.PI * 2)) * 1.4;
  } else if (pose === 4) {
    // Alert: stop, arms up.
    armA = -2.5;
    armB = -0.65;
    legA = 0.18;
    legB = -0.18;
  } else if (pose < 8) {
    // Flee: wide stride, arms flailing high.
    const t = (pose - 5) / 3;
    legA = Math.sin(t * Math.PI * 2) * 1.0;
    legB = -legA;
    armA = -2.2 + Math.sin(t * Math.PI * 2) * 0.5;
    armB = -2.6 - Math.sin(t * Math.PI * 2) * 0.5;
    bob = Math.abs(Math.sin(t * Math.PI * 2)) * 2.4;
  } else {
    // Caught / orbiting: limbs everywhere.
    const t = (pose - 8) / 2;
    armA = -1.2 + t * 3.4;
    armB = 2.4 - t * 3.1;
    legA = 1.4 - t * 2.6;
    legB = -1.6 + t * 2.4;
    bob = 1.8;
  }

  const limb = (x: number, y: number, ang: number, len: number) => {
    g.moveTo(x, y).lineTo(x + Math.sin(ang) * len, y + Math.cos(ang) * len);
  };

  if (bike) {
    g.circle(-h * 0.22, h * 0.36, h * 0.16).stroke({ width: 2, color: INK });
    g.circle(h * 0.22, h * 0.36, h * 0.16).stroke({ width: 2, color: INK });
    g.moveTo(-h * 0.22, h * 0.36).lineTo(h * 0.22, h * 0.36).stroke({ width: 2, color: INK });
  }

  // Legs then arms, dark ink lines.
  limb(0, bodyBot - bob, legA + Math.PI, -h * 0.32);
  limb(0, bodyBot - bob, legB + Math.PI, -h * 0.32);
  g.stroke({ width: lw, color: INK });

  limb(0, bodyTop + h * 0.1 - bob, armA + Math.PI, -h * 0.3);
  limb(0, bodyTop + h * 0.1 - bob, armB + Math.PI, -h * 0.3);
  g.stroke({ width: lw, color: INK });

  // Torso carries the shirt colour.
  g.moveTo(0, bodyTop - bob).lineTo(0, bodyBot - bob).stroke({ width: lw + 2, color: shirt });
  g.moveTo(0, bodyTop - bob).lineTo(0, bodyBot - bob).stroke({ width: lw - 1.4, color: INK });

  g.circle(0, bodyTop - headR * 0.9 - bob, headR).fill(0xf0d9b8).stroke({ width: 2.4, color: INK });

  if (hat) {
    g.rect(-headR * 1.4, bodyTop - headR * 1.5 - bob, headR * 2.8, headR * 0.5).fill(C.siren).stroke({ width: 2, color: INK });
  }
  if (camera) {
    // The storm chaser. Worth 5x mass and a badge.
    g.rect(headR * 0.6, bodyTop - headR * 1.1 - bob, headR * 1.5, headR * 1.1)
      .fill(C.chase).stroke({ width: 2, color: INK });
  }
  return g;
}

// ---------------------------------------------------------------------------
// The atlas
// ---------------------------------------------------------------------------

export interface Art {
  props: Texture[];
  debris: Texture[];
  /** [kind][damageState 0..2] */
  buildings: Texture[][];
  /** [shirt][pose], plus hat/chaser variants keyed separately. */
  men: Texture[][];
  menHat: Texture[][];
  chaser: Texture[];
  bike: Texture[];
  /** Soft radial blob, reused for dust, suction haze and the bloom. */
  blob: Texture;
  ring: Texture;
  spark: Texture;
}

function blobTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  // Concentric discs approximate a radial falloff without a gradient fill.
  for (let i = 12; i >= 1; i--) {
    g.circle(0, 0, (i / 12) * 32).fill({ color: 0xffffff, alpha: 0.075 });
  }
  return tex(renderer, g, 2);
}

function ringTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  g.circle(0, 0, 30).stroke({ width: 4, color: 0xffffff });
  return tex(renderer, g, 2);
}

function sparkTexture(renderer: Renderer): Texture {
  const g = new Graphics();
  g.circle(0, 0, 5).fill(0xffffff);
  return tex(renderer, g, 2);
}

export function buildArt(renderer: Renderer): Art {
  const props: Texture[] = [];
  for (const k of PROP_KINDS) props.push(tex(renderer, propGraphic(k.name, k.r)));

  const debris: Texture[] = [];
  for (const d of DEBRIS_DRAW) {
    const g = new Graphics();
    d(g, 11);
    debris.push(tex(renderer, g));
  }

  const buildings: Texture[][] = [];
  for (let k = 0; k < BUILDING_COLORS.length; k++) {
    buildings.push([buildingTex(renderer, k, 0), buildingTex(renderer, k, 1), buildingTex(renderer, k, 2)]);
  }

  const men: Texture[][] = [];
  const menHat: Texture[][] = [];
  for (let c = 0; c < SHIRTS.length; c++) {
    const a: Texture[] = [];
    const b: Texture[] = [];
    for (let p = 0; p < MAN_POSES; p++) {
      a.push(tex(renderer, stickmanGraphic(p, SHIRTS[c], false, false, false)));
      b.push(tex(renderer, stickmanGraphic(p, SHIRTS[c], true, false, false)));
    }
    men.push(a);
    menHat.push(b);
  }

  const chaser: Texture[] = [];
  const bike: Texture[] = [];
  for (let p = 0; p < MAN_POSES; p++) {
    chaser.push(tex(renderer, stickmanGraphic(p, C.chase, false, false, true)));
    bike.push(tex(renderer, stickmanGraphic(p, SHIRTS[1], false, true, false)));
  }

  return {
    props,
    debris,
    buildings,
    men,
    menHat,
    chaser,
    bike,
    blob: blobTexture(renderer),
    ring: ringTexture(renderer),
    spark: sparkTexture(renderer),
  };
}
