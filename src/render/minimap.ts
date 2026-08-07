/**
 * Minimap. Its real job is the ocean bloom: the heat you paint is visible to
 * every player and bot from across the world, so this is a threat display as
 * much as a navigation aid.
 */

import {
  SST_H,
  SST_W,
  WARM_SST,
  WARM_POOL_RX,
  WARM_POOL_RY,
  WARM_POOL_X,
  WARM_POOL_Y,
  WORLD_H,
  WORLD_W,
  clamp,
} from '../sim/constants.ts';
import type { TerrainData, WorldState } from '../sim/types.ts';

const MW = 256;
const MH = 128;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private land: ImageData;
  private accum = 0;

  constructor(terrain: TerrainData) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MW;
    this.canvas.height = MH;
    this.ctx = this.canvas.getContext('2d')!;

    // Bake the static land mask once; only heat and markers move.
    this.land = this.ctx.createImageData(MW, MH);
    const d = this.land.data;
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const sx = Math.floor((x / MW) * terrain.w);
        const sy = Math.floor((y / MH) * terrain.h);
        const i = (sy * terrain.w + sx) * 4;
        const r = terrain.data[i];
        const o = (y * MW + x) * 4;
        if (r > 192) {
          d[o] = 210; d[o + 1] = 222; d[o + 2] = 232;
        } else if (r < 64) {
          d[o] = 16; d[o + 1] = 34; d[o + 2] = 52;
        } else {
          d[o] = 74; d[o + 1] = 96; d[o + 2] = 68;
        }
        d[o + 3] = 255;
      }
    }
  }

  update(w: WorldState, dt: number): void {
    this.accum += dt;
    if (this.accum < 0.1) return;
    this.accum = 0;

    const ctx = this.ctx;
    ctx.putImageData(this.land, 0, 0);

    // The bloom, straight off the live overlay. Same two contributions as the
    // world layer: an ambient ember on the naturally warm tropics, plus
    // whatever the storms have painted on top.
    for (let y = 0; y < SST_H; y++) {
      for (let x = 0; x < SST_W; x++) {
        const i = y * SST_W + x;
        if (w.sstBase[i] <= 0) continue;
        const ambient = clamp((w.sstBase[i] - WARM_SST) / (255 - WARM_SST), 0, 1);
        const excess = clamp((w.sst[i] - w.sstBase[i]) / 90, 0, 1);
        const t = clamp(ambient * 0.42 + excess, 0, 1);
        if (t <= 0.02) continue;
        ctx.fillStyle = `rgba(201,67,43,${(t * 0.85).toFixed(3)})`;
        ctx.fillRect((x / SST_W) * MW, (y / SST_H) * MH, MW / SST_W + 1, MH / SST_H + 1);
      }
    }

    // The win arena, so the endgame has a named place on the map.
    ctx.strokeStyle = 'rgba(255,194,60,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(
      (WARM_POOL_X / WORLD_W) * MW,
      (WARM_POOL_Y / WORLD_H) * MH,
      (WARM_POOL_RX / WORLD_W) * MW,
      (WARM_POOL_RY / WORLD_H) * MH,
      0, 0, Math.PI * 2,
    );
    ctx.stroke();

    // Rivals, then you on top.
    for (let i = 0; i < w.storms.length; i++) {
      const s = w.storms[i];
      if (!s.alive) continue;
      const isPlayer = s.id === w.playerId;
      if (isPlayer) continue;
      const r = clamp(1 + s.rank * 0.5, 1, 4);
      ctx.fillStyle = s.isLaNina ? '#7fd0ff' : s.rank >= 5 ? '#ff3b30' : 'rgba(228,235,242,0.6)';
      ctx.beginPath();
      ctx.arc((s.x / WORLD_W) * MW, (s.y / WORLD_H) * MH, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const p = w.storms[w.playerId];
    if (p !== undefined && p.alive) {
      ctx.fillStyle = '#31e0c0';
      ctx.beginPath();
      ctx.arc((p.x / WORLD_W) * MW, (p.y / WORLD_H) * MH, clamp(1.5 + p.rank * 0.6, 2, 5), 0, Math.PI * 2);
      ctx.fill();
    }

    // Equator, the line with an opinion.
    ctx.strokeStyle = 'rgba(228,235,242,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, MH / 2);
    ctx.lineTo(MW, MH / 2);
    ctx.stroke();
  }
}
