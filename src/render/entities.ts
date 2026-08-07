/**
 * Ground entities: props, loose debris, stickmen and city blocks.
 *
 * Everything is pooled - nothing is allocated in the hot loop - and everything
 * is culled at camera bounds plus a margin.
 */

import { Container, Sprite, Text, TextStyle } from 'pixi.js';
import { CITY_RESERVE_PER_TIER } from '../sim/constants.ts';
import { ManState } from '../sim/types.ts';
import type { WorldState } from '../sim/types.ts';
import type { Camera } from './camera.ts';
import { C } from './palette.ts';
import { MAN_POSES, type Art } from './textures.ts';

class SpritePool {
  readonly layer = new Container();
  private pool: Sprite[] = [];
  private used = 0;

  next(): Sprite {
    let s = this.pool[this.used];
    if (s === undefined) {
      s = new Sprite();
      s.anchor.set(0.5);
      this.layer.addChild(s);
      this.pool.push(s);
    }
    this.used++;
    s.visible = true;
    return s;
  }

  begin(): void {
    this.used = 0;
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  get count(): number {
    return this.used;
  }
}

const CITY_STYLE = new TextStyle({
  fontFamily: 'Fira Sans Condensed, Arial Narrow, sans-serif',
  fontSize: 17,
  fontWeight: '800',
  fill: 0xe4ebf2,
  stroke: { color: 0x131c26, width: 4, join: 'round' },
});

export class EntitiesView {
  readonly buildingLayer = new Container();
  readonly propLayer = new Container();
  readonly manLayer = new Container();
  readonly debrisLayer = new Container();
  readonly cityLabelLayer = new Container();

  private buildings = new SpritePool();
  private props = new SpritePool();
  private men = new SpritePool();
  private debris = new SpritePool();
  private labels: Text[] = [];
  private labelUsed = 0;

  counts = { props: 0, men: 0, debris: 0, buildings: 0 };

  constructor(private art: Art) {
    this.buildingLayer.addChild(this.buildings.layer);
    this.propLayer.addChild(this.props.layer);
    this.manLayer.addChild(this.men.layer);
    this.debrisLayer.addChild(this.debris.layer);
  }

  private label(): Text {
    let t = this.labels[this.labelUsed];
    if (t === undefined) {
      t = new Text({ text: '', style: CITY_STYLE });
      t.anchor.set(0.5);
      this.cityLabelLayer.addChild(t);
      this.labels.push(t);
    }
    this.labelUsed++;
    t.visible = true;
    return t;
  }

  update(w: WorldState, cam: Camera, reduced: boolean): void {
    const z = cam.zoom;

    // --- cities: buildings, flattening as the reserve drains ---------------
    this.buildings.begin();
    this.labelUsed = 0;
    for (let i = 0; i < w.cities.length; i++) {
      const c = w.cities[i];
      if (!cam.visible(c.x, c.y, c.r + 200)) continue;

      for (let b = 0; b < c.buildings.length; b++) {
        const bd = c.buildings[b];
        if (!cam.visible(bd.x, bd.y, 60)) continue;
        const sp = this.buildings.next();
        const state = bd.dmg >= 1 ? 2 : bd.dmg > 0.35 ? 1 : 0;
        sp.texture = this.art.buildings[bd.kind % this.art.buildings.length][state];
        sp.x = cam.sx(bd.x);
        sp.y = cam.sy(bd.y);
        // Buildings squash as they go down, so collapse reads from above.
        const squash = bd.dmg > 0 && bd.dmg < 1 ? 1 - bd.dmg * 0.35 : 1;
        sp.scale.set(((bd.w / 48) * z) / 1.5, ((bd.h / 48) * z * squash) / 1.5);
        sp.rotation = ((b * 37) % 4) * 0.02;
        sp.alpha = 1;
      }

      if (c.tier <= 2 || z > 0.75) {
        const t = this.label();
        if (t.text !== c.name) t.text = c.name;
        t.x = cam.sx(c.x);
        t.y = cam.sy(c.y - c.r * 0.72);
        t.scale.set(Math.min(1.1, Math.max(0.55, z)));
        const frac = c.reserve / (c.tier * CITY_RESERVE_PER_TIER);
        t.tint = frac <= 0 ? 0x6e6a72 : frac < 0.5 ? C.siren : C.stormLit;
        t.alpha = 0.85;
      }
    }
    this.buildings.end();
    for (let i = this.labelUsed; i < this.labels.length; i++) this.labels[i].visible = false;

    // --- props -------------------------------------------------------------
    this.props.begin();
    for (const chunk of w.chunks.values()) {
      const list = chunk.props;
      for (let p = 0; p < list.length; p++) {
        const pr = list[p];
        if (!pr.alive || !cam.visible(pr.x, pr.y, pr.r + 20)) continue;
        const sp = this.props.next();
        sp.texture = this.art.props[pr.type];
        sp.x = cam.sx(pr.x);
        sp.y = cam.sy(pr.y);
        sp.scale.set(z);
        // Deterministic per-prop rotation so the world does not shimmer.
        sp.rotation = ((pr.x * 7.3 + pr.y * 3.1) % 6.283) * (pr.cls === 1 ? 1 : 0.35);
        sp.alpha = 1;
      }
    }
    this.props.end();

    // --- stickmen: the game's juice ---------------------------------------
    this.men.begin();
    for (let i = 0; i < w.stickmen.length; i++) {
      const m = w.stickmen[i];
      if (!m.active || !cam.visible(m.x, m.y, 40)) continue;
      const sp = this.men.next();

      let pose: number;
      if (m.state === ManState.Caught) pose = 8 + (Math.floor(m.ph * 5) % 2);
      else if (m.state === ManState.Flee) pose = 5 + (Math.floor(m.ph * 4) % 3);
      else if (m.state === ManState.Alert) pose = 4;
      else pose = Math.floor(m.ph * 1.6) % 4;
      pose = pose % MAN_POSES;

      const set = m.chaser
        ? this.art.chaser
        : m.bike
          ? this.art.bike
          : m.hat
            ? this.art.menHat[m.c]
            : this.art.men[m.c];
      sp.texture = set[pose];
      sp.x = cam.sx(m.x);
      sp.y = cam.sy(m.y);
      sp.scale.set(z * m.h, z * m.h);
      // Face the way they are running; tumble while caught.
      sp.rotation = m.state === ManState.Caught && !reduced ? m.ph * 4 : Math.sin(m.ph) * 0.08;
      sp.alpha = 1;
    }
    this.men.end();

    // --- loose debris -------------------------------------------------------
    this.debris.begin();
    for (let i = 0; i < w.debris.length; i++) {
      const d = w.debris[i];
      if (!d.active || !cam.visible(d.x, d.y, 30)) continue;
      const sp = this.debris.next();
      sp.texture = this.art.debris[d.type % this.art.debris.length];
      sp.x = cam.sx(d.x);
      sp.y = cam.sy(d.y);
      const s = z * Math.min(1.4, 0.55 + d.mass * 0.09);
      sp.scale.set(s);
      sp.rotation = reduced ? 0 : d.life * 5.5 + i;
      sp.alpha = 1;
    }
    this.debris.end();

    this.counts.buildings = this.buildings.count;
    this.counts.props = this.props.count;
    this.counts.men = this.men.count;
    this.counts.debris = this.debris.count;
  }
}
