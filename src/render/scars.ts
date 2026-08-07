/**
 * Ground scarring. Megastorm and above leave a fading dark path; at El Nino
 * it persists 30 seconds. Players read where rivals have been.
 *
 * A coarse CPU canvas updated at 10Hz, drawn under everything with multiply
 * blending. Cheap enough to be free, readable enough to matter.
 */

import { Container, Sprite, Texture } from 'pixi.js';
import { WORLD_H, WORLD_W, clamp, coreRadius } from '../sim/constants.ts';
import { sampleTerrain } from '../sim/terrain.ts';
import type { Storm, TerrainData } from '../sim/types.ts';
import type { Camera } from './camera.ts';
import { SCAR_H, SCAR_W } from './limits.ts';

export class Scars {
  readonly layer = new Container();
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: Texture;
  private sprites: Sprite[] = [];
  private accum = 0;

  constructor(private terrain: TerrainData) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCAR_W;
    this.canvas.height = SCAR_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.clearRect(0, 0, SCAR_W, SCAR_H);
    this.tex = Texture.from(this.canvas);
    this.tex.source.scaleMode = 'linear';

    for (let i = 0; i < 3; i++) {
      const s = new Sprite(this.tex);
      s.anchor.set(0, 0);
      s.blendMode = 'multiply';
      this.layer.addChild(s);
      this.sprites.push(s);
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, SCAR_W, SCAR_H);
    this.tex.source.update();
  }

  update(storms: Storm[], cam: Camera, dt: number): void {
    this.accum += dt;
    if (this.accum >= 0.1) {
      const step = this.accum;
      this.accum = 0;
      const ctx = this.ctx;

      // Fade. El Nino scars persist ~30s, Megastorm ~8s; one global fade rate
      // tuned to the longer of the two, with rank driving the ink laid down.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${clamp(step / 30, 0, 1)})`;
      ctx.fillRect(0, 0, SCAR_W, SCAR_H);
      ctx.globalCompositeOperation = 'source-over';

      for (let i = 0; i < storms.length; i++) {
        const s = storms[i];
        if (!s.alive || s.rank < 5) continue;
        // Ground scarring, so only on ground.
        if (sampleTerrain(this.terrain, s.x, s.y).water) continue;
        const px = (s.x / WORLD_W) * SCAR_W;
        const py = (s.y / WORLD_H) * SCAR_H;
        const r = Math.max(1.2, (coreRadius(s.mass) / WORLD_W) * SCAR_W);
        const strength = s.rank >= 6 ? 0.28 : 0.14;
        ctx.fillStyle = `rgba(24,32,44,${strength})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        // Draw the wrapped twin so a scar laid on the seam is continuous.
        ctx.beginPath();
        ctx.arc(px > SCAR_W / 2 ? px - SCAR_W : px + SCAR_W, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      this.tex.source.update();
    }

    for (let copy = 0; copy < 3; copy++) {
      const s = this.sprites[copy];
      const offset = (copy - 1) * WORLD_W;
      s.x = cam.w * 0.5 + (offset - cam.x) * cam.zoom;
      s.y = cam.h * 0.5 + (0 - cam.y) * cam.zoom;
      s.scale.set((WORLD_W / SCAR_W) * cam.zoom, (WORLD_H / SCAR_H) * cam.zoom);
      s.visible = s.x < cam.w + 4 && s.x + WORLD_W * cam.zoom > -4;
    }
  }
}
