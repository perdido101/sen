/**
 * The visible map: a stylized art layer built from the data map at boot, plus
 * the live ocean bloom.
 *
 * Data and beauty stay decoupled - the sim never reads a pixel of this.
 *
 * THE SIGNATURE (§6): the ocean is a live heat map that the player personally
 * paints. Feeding in warm water bleeds red across the sea in a spreading bloom
 * that never fully resets during a run, is visible on every minimap, and
 * deepens toward --warm-sea as you approach Super El Nino. By the end of a good
 * run the Pacific is a wound.
 */

import { Container, Sprite, Texture } from 'pixi.js';
import {
  SST_H,
  SST_W,
  WARM_SST,
  WORLD_H,
  WORLD_W,
  clamp,
} from '../sim/constants.ts';
import { valueNoise } from '../sim/rng.ts';
import type { TerrainData, WorldState } from '../sim/types.ts';
import { BIOME_COLOR, C } from './palette.ts';
import type { Camera } from './camera.ts';

/** Art tiles: two 2048x2048 halves keep us inside mobile texture limits while
 *  still giving 2x magnification instead of 4x. */
const TILE = 2048;
const TILES_X = 2;

function biomeOfG(g: number): number {
  return clamp(Math.round(g / 40), 0, 6);
}

function paintTile(t: TerrainData, tileX: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = TILE;
  cv.height = TILE;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(TILE, TILE);
  const out = img.data;

  // Terrain pixels covered by this tile.
  const srcW = t.w / TILES_X;
  const sx0 = tileX * srcW;

  for (let y = 0; y < TILE; y++) {
    const sy = Math.min(t.h - 1, Math.floor((y / TILE) * t.h));
    for (let x = 0; x < TILE; x++) {
      const sx = Math.min(t.w - 1, Math.floor(sx0 + (x / TILE) * srcW));
      const i = (sy * t.w + sx) * 4;
      const r = t.data[i];
      const g = t.data[i + 1];
      const b = t.data[i + 2];

      let col: number;

      if (r > 192) {
        col = C.snow;
      } else if (r < 64) {
        // Quiet baseline ocean. The live bloom is what carries the drama.
        const warmth = clamp((b - 120) / 135, 0, 1);
        col = mixi(0x143a58, C.coolSea, clamp(b / 210, 0, 1));
        col = mixi(col, 0x5f6f7a, warmth * 0.16);
      } else {
        const biome = biomeOfG(g);
        col = BIOME_COLOR[biome];
        // Elevation shading: highlands catch the light, lowlands sink.
        const e = b / 255;
        col = shadei(col, 0.86 + e * 0.34);
      }

      // Fine dither so large biome fields do not read as flat vinyl.
      const n = valueNoise(sx * 0.9, sy * 0.9, 991);
      col = shadei(col, 0.94 + n * 0.12);

      // Crisp coastline: dark ink wherever land meets water.
      if (r >= 64) {
        const w0 = t.data[(sy * t.w + ((sx + 1) % t.w)) * 4] < 64;
        const w1 = t.data[(sy * t.w + ((sx - 1 + t.w) % t.w)) * 4] < 64;
        const w2 = sy > 0 && t.data[((sy - 1) * t.w + sx) * 4] < 64;
        const w3 = sy < t.h - 1 && t.data[((sy + 1) * t.w + sx) * 4] < 64;
        if (w0 || w1 || w2 || w3) col = mixi(col, C.ink, 0.62);
      }

      const o = (y * TILE + x) * 4;
      out[o] = (col >> 16) & 255;
      out[o + 1] = (col >> 8) & 255;
      out[o + 2] = col & 255;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function mixi(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  return (
    (((ar + (((b >> 16) & 255) - ar) * t) | 0) << 16) |
    (((ag + (((b >> 8) & 255) - ag) * t) | 0) << 8) |
    ((ab + ((b & 255) - ab) * t) | 0)
  );
}

function shadei(c: number, k: number): number {
  const r = clamp(((c >> 16) & 255) * k, 0, 255) | 0;
  const g = clamp(((c >> 8) & 255) * k, 0, 255) | 0;
  const b = clamp((c & 255) * k, 0, 255) | 0;
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------

export class Background {
  readonly layer = new Container();
  readonly bloomLayer = new Container();

  private tiles: Sprite[][] = [];
  private bloomSprites: Sprite[] = [];
  private bloomCanvas: HTMLCanvasElement;
  private bloomCtx: CanvasRenderingContext2D;
  private bloomImg: ImageData;
  private bloomTex: Texture;
  private accum = 0;
  private warpT = 0;

  /** Scrolls to 1 as the player nears Super El Nino, deepening the bloom. */
  intensity = 0;

  constructor(terrain: TerrainData) {
    // Ground tiles: 3 wrapped copies each, so flying east forever never seams.
    for (let copy = 0; copy < 3; copy++) this.tiles.push([]);
    for (let tx = 0; tx < TILES_X; tx++) {
      const canvas = paintTile(terrain, tx);
      const tex = Texture.from(canvas);
      for (let copy = 0; copy < 3; copy++) {
        const s = new Sprite(tex);
        s.anchor.set(0, 0);
        this.layer.addChild(s);
        this.tiles[copy].push(s);
      }
    }

    // Live sea-surface-temperature overlay, rebuilt at 10Hz.
    this.bloomCanvas = document.createElement('canvas');
    this.bloomCanvas.width = SST_W;
    this.bloomCanvas.height = SST_H;
    this.bloomCtx = this.bloomCanvas.getContext('2d', { willReadFrequently: true })!;
    this.bloomImg = this.bloomCtx.createImageData(SST_W, SST_H);
    this.bloomTex = Texture.from(this.bloomCanvas);
    this.bloomTex.source.scaleMode = 'linear';

    // Two passes per wrapped copy. The first is a straight colour pass, which
    // is what actually carries the sea toward --warm-sea; the second is the
    // soft additive glow on top. Additive alone over --cool-sea reads purple,
    // not red, and the red ocean is the whole identity.
    for (let pass = 0; pass < 2; pass++) {
      for (let copy = 0; copy < 3; copy++) {
        const s = new Sprite(this.bloomTex);
        s.anchor.set(0, 0);
        s.blendMode = pass === 0 ? 'normal' : 'add';
        s.alpha = pass === 0 ? 1 : 0.4;
        this.bloomLayer.addChild(s);
        this.bloomSprites.push(s);
      }
    }
  }

  /**
   * Rebuild the bloom texture. Domain-warped on the CPU at 10Hz so the field
   * breathes instead of sitting there as a static stain - the sim updates the
   * overlay at the same rate, so nothing is wasted.
   */
  private rebuildBloom(w: WorldState): void {
    const out = this.bloomImg.data;
    const sst = w.sst;
    const base = w.sstBase;
    const warp = this.warpT;
    const boost = 0.55 + this.intensity * 0.75;

    for (let y = 0; y < SST_H; y++) {
      for (let x = 0; x < SST_W; x++) {
        // Slow domain warp: sample a neighbour chosen by a drifting noise
        // field, so the bloom edge undulates like weather.
        const nx = valueNoise(x * 0.09 + warp, y * 0.09, 17) - 0.5;
        const ny = valueNoise(x * 0.09, y * 0.09 + warp * 0.8, 43) - 0.5;
        const sxi = (Math.round(x + nx * 5) + SST_W) % SST_W;
        const syi = clamp(Math.round(y + ny * 5), 0, SST_H - 1);
        const si = syi * SST_W + sxi;

        const o = (y * SST_W + x) * 4;
        if (base[si] <= 0) {
          // Land. The bloom is a sea-surface field and nothing else.
          out[o + 3] = 0;
          continue;
        }

        // Two contributions, and both matter. The baseline gives the tropics -
        // and above all the equatorial Pacific warm pool - a permanent ember
        // so the win arena is visible from across the ocean. The excess is
        // what the player personally painted, and it is what turns the Pacific
        // into a wound by the end of a good run.
        const ambient = clamp((base[si] - WARM_SST) / (255 - WARM_SST), 0, 1);
        const excess = clamp((sst[si] - base[si]) / 90, 0, 1);
        const t = clamp(ambient * 0.42 + excess, 0, 1);
        if (t <= 0.01) {
          out[o + 3] = 0;
          continue;
        }
        const a = Math.pow(t, 0.85) * 225 * boost;
        out[o] = 201;
        out[o + 1] = (67 - t * 30) | 0;
        out[o + 2] = 43;
        out[o + 3] = clamp(a, 0, 255);
      }
    }
    this.bloomCtx.putImageData(this.bloomImg, 0, 0);
    this.bloomTex.source.update();
  }

  update(w: WorldState, cam: Camera, dt: number): void {
    this.warpT += dt * 0.22;
    this.accum += dt;
    if (this.accum >= 0.1) {
      this.accum = 0;
      this.rebuildBloom(w);
    }

    // World-space scale for each tile.
    const tileWorldW = WORLD_W / TILES_X;
    const scale = (tileWorldW / TILE) * cam.zoom;

    for (let copy = 0; copy < 3; copy++) {
      const offset = (copy - 1) * WORLD_W;
      for (let tx = 0; tx < TILES_X; tx++) {
        const s = this.tiles[copy][tx];
        const wx = offset + tx * tileWorldW;
        // Positioned directly rather than through wrapDeltaX: these are the
        // wrapped copies, so they must sit adjacent, not all snap to nearest.
        s.x = cam.w * 0.5 + (wx - cam.x) * cam.zoom;
        s.y = cam.h * 0.5 + (0 - cam.y) * cam.zoom;
        s.scale.set(scale, (WORLD_H / TILE) * cam.zoom);
        s.visible = s.x < cam.w + 4 && s.x + tileWorldW * cam.zoom > -4;
      }
      for (let pass = 0; pass < 2; pass++) {
        const b = this.bloomSprites[pass * 3 + copy];
        b.x = cam.w * 0.5 + (offset - cam.x) * cam.zoom;
        b.y = cam.h * 0.5 + (0 - cam.y) * cam.zoom;
        b.scale.set((WORLD_W / SST_W) * cam.zoom, (WORLD_H / SST_H) * cam.zoom);
        b.visible = b.x < cam.w + 4 && b.x + WORLD_W * cam.zoom > -4;
      }
    }
  }
}
