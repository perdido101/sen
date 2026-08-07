/**
 * Renderer orchestrator.
 *
 * The renderer subscribes to state; state never knows the renderer exists.
 * Layer order matters: ground, scars, bloom, then everything that stands on
 * top of the sea.
 */

import { Application, Container, Graphics } from 'pixi.js';
import {
  RANK_EL_NINO,
  WARM_POOL_RX,
  WARM_POOL_RY,
  WARM_POOL_X,
  WARM_POOL_Y,
  clamp,
  fieldRadius,
} from '../sim/constants.ts';
import type { SimEvent, WorldState } from '../sim/types.ts';
import { Background } from './background.ts';
import { Camera } from './camera.ts';
import { EntitiesView } from './entities.ts';
import { Minimap } from './minimap.ts';
import { Particles } from './particles.ts';
import { C } from './palette.ts';
import { Scars } from './scars.ts';
import { StormsView } from './stormView.ts';
import { buildArt, type Art } from './textures.ts';

export class GameRenderer {
  readonly cam = new Camera();
  readonly art: Art;
  readonly minimap: Minimap;

  private bg: Background;
  private scars: Scars;
  private entities: EntitiesView;
  private storms: StormsView;
  private particles: Particles;
  private arena = new Graphics();
  private vignette = new Graphics();
  private desat = new Graphics();
  private root = new Container();

  /** 0..1, drives the world desaturating on death. */
  fade = 0;
  reducedMotion = false;

  /**
   * Dissipation: rings peel off one at a time over 0.8s. Held here rather than
   * in StormsView because the storm is already gone from the simulation by the
   * time this plays - death is a renderer beat, not a sim entity.
   */
  private peel = { t: -1, x: 0, y: 0, r: 0, next: 0 };
  /** On the win, everything holds for a beat and the whole ocean flashes. */
  private winFlash = -1;

  constructor(private app: Application, world: WorldState) {
    this.art = buildArt(app.renderer);
    this.bg = new Background(world.terrain);
    this.scars = new Scars(world.terrain);
    this.entities = new EntitiesView(this.art);
    this.storms = new StormsView(this.art);
    this.particles = new Particles(this.art);
    this.minimap = new Minimap(world.terrain);

    this.root.addChild(
      this.bg.layer,
      this.scars.layer,
      this.bg.bloomLayer,
      this.arena,
      this.entities.propLayer,
      this.entities.buildingLayer,
      this.entities.manLayer,
      this.entities.debrisLayer,
      this.storms.layer,
      this.particles.layer,
      this.entities.cityLabelLayer,
      this.particles.numberLayer,
      this.vignette,
      this.desat,
    );
    app.stage.addChild(this.root);
  }

  resize(w: number, h: number): void {
    this.cam.resize(w, h);
    this.vignette.clear();
    // Quiet vignette in --deep so the bloom keeps all the contrast.
    for (let i = 0; i < 8; i++) {
      const t = i / 8;
      this.vignette
        .rect(-w * t * 0.06, -h * t * 0.06, w * (1 + t * 0.12), h * (1 + t * 0.12))
        .stroke({ width: Math.max(w, h) * 0.04, color: C.deep, alpha: 0.09 });
    }
  }

  /** The named place everyone converges on gets a ring you can see from afar. */
  private drawArena(w: WorldState): void {
    const g = this.arena;
    g.clear();
    const p = w.storms[w.playerId];
    if (p === undefined) return;
    const show = p.rank >= 5 || p.winTimer > 0;
    if (!show) return;
    const cx = this.cam.sx(WARM_POOL_X);
    const cy = this.cam.sy(WARM_POOL_Y);
    const rx = WARM_POOL_RX * this.cam.zoom;
    const ry = WARM_POOL_RY * this.cam.zoom;
    if (cx < -rx * 2 || cx > this.cam.w + rx * 2) return;
    g.ellipse(cx, cy, rx, ry).stroke({
      width: 3,
      color: C.crown,
      alpha: p.rank >= RANK_EL_NINO ? 0.7 : 0.3,
    });
  }

  /** React to what the simulation just published. */
  handleEvents(w: WorldState, events: SimEvent[]): void {
    const p = w.storms[w.playerId];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const mine = e.storm === w.playerId;
      switch (e.type) {
        case 'absorb':
          this.particles.spawn(e.x, e.y, 0, -20, 0.35, 0.5, C.debris, 0);
          if (mine && e.a >= 2) this.particles.number(e.x, e.y, e.a);
          break;
        case 'buildingCollapse':
          this.particles.plume(e.x, e.y);
          if (p !== undefined && this.cam.visible(e.x, e.y, 200)) this.cam.addTrauma(0.16);
          break;
        case 'shred':
          this.particles.burst(e.x, e.y, 14, 240, C.siren, 0.65, 0.8);
          this.particles.shock(e.x, e.y, 1.6, C.siren);
          if (mine) this.cam.addTrauma(0.8);
          break;
        case 'eyeHit':
          this.particles.burst(e.x, e.y, 10, 200, C.crown, 0.6, 0.7);
          if (mine) this.cam.addTrauma(0.55);
          break;
        case 'dissipate': {
          this.particles.burst(e.x, e.y, 26, 300, C.storm, 1.0, 1.1);
          if (mine) {
            this.cam.addTrauma(1);
            const s = w.storms[e.storm];
            this.peel.t = 0;
            this.peel.next = 0;
            this.peel.x = e.x;
            this.peel.y = e.y;
            this.peel.r = fieldRadius(Math.max(10, s?.stats.peakMass ?? 10)) * 0.5;
          } else {
            this.particles.shock(e.x, e.y, 2.4, C.stormLit);
          }
          break;
        }
        case 'rankUp':
          if (mine) {
            this.cam.zoomPunch();
            this.particles.shock(e.x, e.y, 3, C.crown);
          }
          break;
        case 'cityDrainStart':
          if (mine) this.cam.addTrauma(0.25);
          break;
        case 'win':
          this.particles.burst(e.x, e.y, 40, 420, C.crown, 1.4, 1.4);
          if (mine) this.winFlash = 0;
          break;
        case 'boostEject':
          this.particles.spawn(
            e.x + Math.cos(e.a) * 20,
            e.y + Math.sin(e.a) * 20,
            Math.cos(e.a) * 60,
            Math.sin(e.a) * 60,
            0.5, 0.8, C.debris, 0,
          );
          break;
        default:
          break;
      }
    }
  }

  draw(w: WorldState, dt: number): void {
    const p = w.storms[w.playerId];
    this.cam.reducedMotion = this.reducedMotion;
    if (p !== undefined && p.alive) {
      this.cam.follow(p.x, p.y, p.ang, p.mass, dt);
      // The bloom deepens toward --warm-sea as you approach Super El Nino.
      this.bg.intensity = clamp((p.mass - 900) / 4100, 0, 1);
    }

    this.bg.update(w, this.cam, dt);
    this.scars.update(w.storms, this.cam, dt);
    this.drawArena(w);
    this.entities.update(w, this.cam, this.reducedMotion);
    this.storms.update(w.storms, w.playerId, this.cam, w.time, this.reducedMotion);
    this.particles.update(dt, this.cam);
    this.minimap.update(w, dt);

    this.updatePeel(dt);

    this.desat.clear();

    // The win: everything holds for a beat, then the whole ocean flashes to
    // --warm-sea. This is the screenshot, so it gets its own pass over the top
    // of the world and under the UI.
    if (this.winFlash >= 0) {
      this.winFlash += dt;
      const hold = 0.45;
      const t = (this.winFlash - hold) / 1.1;
      if (this.winFlash > hold && t < 1) {
        const a = this.reducedMotion ? 0.35 * (1 - t) : Math.sin(t * Math.PI) * 0.75;
        this.desat.rect(0, 0, this.cam.w, this.cam.h).fill({ color: C.warmSea, alpha: a });
      }
      if (this.winFlash > hold + 1.1) this.winFlash = -1;
      this.bg.intensity = 1;
    }

    // World desaturates over 400ms on death.
    if (this.fade > 0) {
      this.desat.rect(0, 0, this.cam.w, this.cam.h).fill({ color: C.deep, alpha: this.fade * 0.55 });
    }
  }

  /** Four rings, one every 0.2s, each wider than the last. */
  private updatePeel(dt: number): void {
    if (this.peel.t < 0) return;
    this.peel.t += dt;
    while (this.peel.next < 4 && this.peel.t >= this.peel.next * 0.2) {
      const k = this.peel.next;
      this.particles.shock(this.peel.x, this.peel.y, (this.peel.r / 30) * (0.7 + k * 0.5), C.stormLit);
      this.particles.burst(this.peel.x, this.peel.y, 7, 150 + k * 90, C.debris, 0.8, 0.6);
      this.peel.next++;
    }
    if (this.peel.t > 0.9) this.peel.t = -1;
  }

  reset(w: WorldState): void {
    this.storms.reset();
    this.particles.clear();
    this.scars.clear();
    this.fade = 0;
    this.peel.t = -1;
    this.winFlash = -1;
    const p = w.storms[w.playerId];
    if (p !== undefined) this.cam.snapTo(p.x, p.y);
  }

  get counts(): { props: number; men: number; debris: number; buildings: number } {
    return this.entities.counts;
  }

  get drawCalls(): number {
    // Pixi does not expose a stable counter across versions; approximate with
    // the number of live containers, which is what actually drives batching.
    return this.root.children.length;
  }

  get pixi(): Application {
    return this.app;
  }
}
