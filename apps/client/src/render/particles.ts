/**
 * Particles and floating numbers. Pooled, capped, and batched.
 *
 * Absorb pops: each item scale-spins into the eye with a small +mass number
 * floating up. Capped at 6 visible numbers so a city drain does not turn into
 * a wall of text.
 */

import { Container, Sprite, Text, TextStyle } from 'pixi.js';
import { CAP_PARTICLES } from './limits.ts';
import type { Camera } from './camera.ts';
import { C } from './palette.ts';
import type { Art } from './textures.ts';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  spin: number;
  rot: number;
  tint: number;
  kind: number; // 0 blob, 1 spark, 2 ring
  active: boolean;
}

const NUM_STYLE = new TextStyle({
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSize: 14,
  fontWeight: '600',
  fill: 0xffc23c,
  stroke: { color: 0x131c26, width: 3, join: 'round' },
});

interface Num {
  x: number;
  y: number;
  life: number;
  text: string;
  active: boolean;
}

const MAX_NUMBERS = 6;

export class Particles {
  readonly layer = new Container();
  readonly numberLayer = new Container();

  private pool: P[] = [];
  private sprites: Sprite[] = [];
  private cursor = 0;

  private nums: Num[] = [];
  private numTexts: Text[] = [];

  constructor(private art: Art) {
    for (let i = 0; i < CAP_PARTICLES; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1,
        spin: 0, rot: 0, tint: 0xffffff, kind: 0, active: false,
      });
      const s = new Sprite(art.blob);
      s.anchor.set(0.5);
      s.visible = false;
      this.layer.addChild(s);
      this.sprites.push(s);
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      this.nums.push({ x: 0, y: 0, life: 0, text: '', active: false });
      const t = new Text({ text: '', style: NUM_STYLE });
      t.anchor.set(0.5);
      t.visible = false;
      this.numberLayer.addChild(t);
      this.numTexts.push(t);
    }
  }

  spawn(
    x: number, y: number, vx: number, vy: number,
    life: number, size: number, tint: number, kind = 0,
  ): void {
    // Ring buffer: never search, never allocate. Oldest particle loses.
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = 0; p.max = life; p.size = size;
    p.rot = 0; p.spin = (this.cursor % 7) * 0.4 - 1.2;
    p.tint = tint; p.kind = kind; p.active = true;
  }

  burst(x: number, y: number, n: number, speed: number, tint: number, life = 0.6, size = 0.7): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (this.cursor % 10) * 0.1;
      const s = speed * (0.5 + ((i * 37) % 10) / 10);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s, life, size, tint, 1);
    }
  }

  /** Dust plume from a collapsing building. */
  plume(x: number, y: number): void {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.spawn(x, y, Math.cos(a) * 26, Math.sin(a) * 26 - 12, 1.1, 1.5, C.debris, 0);
    }
  }

  shock(x: number, y: number, size: number, tint: number): void {
    this.spawn(x, y, 0, 0, 0.45, size, tint, 2);
  }

  number(x: number, y: number, amount: number): void {
    for (let i = 0; i < this.nums.length; i++) {
      const n = this.nums[i];
      if (n.active) continue;
      n.x = x;
      n.y = y;
      n.life = 0;
      n.text = `+${amount < 10 ? amount.toFixed(1) : Math.round(amount)}`;
      n.active = true;
      return;
    }
  }

  update(dt: number, cam: Camera): void {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      const s = this.sprites[i];
      if (!p.active) {
        if (s.visible) s.visible = false;
        continue;
      }
      p.life += dt;
      if (p.life >= p.max) {
        p.active = false;
        s.visible = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.rot += p.spin * dt;

      const t = p.life / p.max;
      if (!cam.visible(p.x, p.y, 80)) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      s.texture = p.kind === 1 ? this.art.spark : p.kind === 2 ? this.art.ring : this.art.blob;
      s.x = cam.sx(p.x);
      s.y = cam.sy(p.y);
      s.rotation = p.rot;
      s.tint = p.tint;
      s.blendMode = p.kind === 0 ? 'normal' : 'add';
      const grow = p.kind === 2 ? 1 + t * 2.6 : 1 + t * 0.5;
      s.scale.set((p.size * grow * cam.zoom * 32) / 32);
      s.alpha = (1 - t) * (p.kind === 0 ? 0.55 : 0.9);
    }

    for (let i = 0; i < this.nums.length; i++) {
      const n = this.nums[i];
      const t = this.numTexts[i];
      if (!n.active) {
        t.visible = false;
        continue;
      }
      n.life += dt;
      if (n.life > 0.8) {
        n.active = false;
        t.visible = false;
        continue;
      }
      if (t.text !== n.text) t.text = n.text;
      t.visible = true;
      t.x = cam.sx(n.x);
      t.y = cam.sy(n.y) - n.life * 42;
      t.alpha = 1 - n.life / 0.8;
      t.scale.set(Math.min(1.1, cam.zoom + 0.2));
    }
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
    for (const n of this.nums) n.active = false;
  }
}
