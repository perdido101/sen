/**
 * The storm itself.
 *
 * 3-4 stacked rotating rings of debris at different radii, velocities and
 * alpha, over a procedurally drawn spiral body. At Hurricane rank and above it
 * flattens from a funnel into a wide spiral with a visible eye - the
 * silhouette alone should tell you the rank.
 */

import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import {
  CORIOLIS_FLIP_TIME,
  RANK_EL_NINO,
  WIN_HOLD_TIME,
  coreRadius,
  eyeRadius,
  fieldRadius,
  suctionRadius,
} from '@sen/sim/sim/constants.ts';
import { fieldItemPos } from '@sen/sim/sim/storm.ts';
import type { Storm } from '@sen/sim/sim/types.ts';
import type { Camera } from './camera.ts';
import { C, mix } from './palette.ts';
import type { Art } from './textures.ts';

const NAME_STYLE = new TextStyle({
  fontFamily: 'Fira Sans Condensed, Arial Narrow, sans-serif',
  fontSize: 15,
  fontWeight: '800',
  fill: 0xe4ebf2,
  stroke: { color: 0x131c26, width: 4, join: 'round' },
});

class StormView {
  readonly root = new Container();
  private haze = new Sprite();
  private body = new Graphics();
  private eye = new Graphics();
  private holdRing = new Graphics();
  private field = new Container();
  private items: Sprite[] = [];
  private label: Text;
  private lastName = '';

  constructor(private art: Art) {
    this.haze.texture = art.blob;
    this.haze.anchor.set(0.5);
    this.haze.blendMode = 'add';
    this.label = new Text({ text: '', style: NAME_STYLE });
    this.label.anchor.set(0.5, 1);
    this.root.addChild(this.haze, this.body, this.field, this.eye, this.holdRing, this.label);
  }

  private item(i: number): Sprite {
    let s = this.items[i];
    if (s === undefined) {
      s = new Sprite();
      s.anchor.set(0.5);
      this.field.addChild(s);
      this.items[i] = s;
    }
    return s;
  }

  update(s: Storm, cam: Camera, isPlayer: boolean, time: number, reduced: boolean): void {
    const z = cam.zoom;
    const cx = cam.sx(s.x);
    const cy = cam.sy(s.y);
    this.root.x = cx;
    this.root.y = cy;

    const core = coreRadius(s.mass);
    const fr = fieldRadius(s.mass);
    const suck = suctionRadius(s.mass);
    const rank = s.rank;
    // Past Hurricane the funnel flattens into a wide spiral with a real eye.
    const flat = Math.min(1, Math.max(0, (rank - 3) / 2));

    // La Nina reads cold-blue against every other storm on the map.
    const tint = s.isLaNina ? 0x7fd0ff : isPlayer ? C.stormLit : C.storm;
    const hurtMix = s.hurt > 0 ? Math.min(1, s.hurt / 0.35) : 0;

    // Suction haze, plus a dark ground shadow so the storm sits on the world
    // instead of floating as a translucent smudge over it.
    this.haze.scale.set((suck * z) / 32);
    this.haze.tint = mix(tint, C.siren, hurtMix * 0.8);
    this.haze.alpha = 0.13 + flat * 0.07;

    // --- body: spiral arms ------------------------------------------------
    const g = this.body;
    g.clear();
    g.circle(0, 0, coreRadius(s.mass) * z * 1.5).fill({ color: C.deep, alpha: 0.4 });
    const spin = s.fieldRot;
    const arms = 3 + Math.min(2, rank - 1);
    const bodyR = core * z;

    // Unwind the whole field for 0.5s after an equator crossing.
    const flipT = s.spinFlip > 0 ? s.spinFlip / CORIOLIS_FLIP_TIME : 0;
    const flipWobble = flipT > 0 ? Math.sin(flipT * Math.PI) * 0.5 : 0;

    for (let a = 0; a < arms; a++) {
      const base = (a / arms) * Math.PI * 2 + spin * 0.9;
      const steps = 9;
      g.moveTo(0, 0);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // A logarithmic-ish spiral; flatter storms wind tighter and wider.
        const ang = base + t * (2.4 - flat * 0.9) * -s.spinDir + flipWobble * t;
        const r = bodyR * (0.18 + t * (0.95 + flat * 0.5));
        g.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
      }
      // Two passes: a wide soft arm and a bright inner filament, which is what
      // makes the spiral read at a glance instead of dissolving into the
      // ground colour.
      g.stroke({
        width: Math.max(3, bodyR * (0.36 - flat * 0.12)),
        color: mix(tint, C.siren, hurtMix),
        alpha: 0.62,
        cap: 'round',
      });
    }
    for (let a = 0; a < arms; a++) {
      const base = (a / arms) * Math.PI * 2 + spin * 0.9;
      const steps = 9;
      g.moveTo(0, 0);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ang = base + t * (2.4 - flat * 0.9) * -s.spinDir + flipWobble * t;
        const r = bodyR * (0.18 + t * (0.95 + flat * 0.5));
        g.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
      }
      g.stroke({
        width: Math.max(1.5, bodyR * 0.1),
        color: C.stormLit,
        alpha: 0.5,
        cap: 'round',
      });
    }

    // Scrolling noise texture, faked with a counter-rotating inner disc.
    g.circle(0, 0, bodyR * 0.62).fill({ color: tint, alpha: 0.34 });
    g.circle(
      Math.cos(-spin * 1.6) * bodyR * 0.1,
      Math.sin(-spin * 1.6) * bodyR * 0.1,
      bodyR * 0.4,
    ).fill({ color: C.stormLit, alpha: 0.2 });

    // --- field: the weapon -------------------------------------------------
    const n = s.field.length;
    for (let i = 0; i < n; i++) {
      const it = s.field[i];
      const sp = this.item(i);
      const p = fieldItemPos(s, it);
      sp.visible = true;
      sp.texture = it.cls === 1 ? this.art.men[it.type % 6][8 + (i % 2)] : this.art.debris[it.type % this.art.debris.length];
      sp.x = cam.sx(p.x) - cx;
      sp.y = cam.sy(p.y) - cy;
      const wob = reduced ? 0 : Math.sin(it.wob) * 0.12;
      sp.scale.set(z * (0.75 + it.rt * 0.4 + wob));
      sp.rotation = it.ang * 2.2 + spin * it.spin * 2;
      // Outer rings sit lighter, so the field reads as depth rather than soup.
      sp.alpha = it.t * (0.55 + (1 - it.rt) * 0.45);
    }
    for (let i = n; i < this.items.length; i++) this.items[i].visible = false;

    // --- eye: your vulnerable part ----------------------------------------
    const er = eyeRadius(s.mass) * z;
    this.eye.clear();
    this.eye.circle(0, 0, er).fill({ color: C.deep, alpha: 0.55 + flat * 0.3 });
    this.eye.circle(0, 0, er).stroke({
      width: Math.max(1.5, er * 0.18),
      color: s.invuln > 0 && Math.floor(time * 12) % 2 === 0 ? C.crown : mix(tint, C.siren, hurtMix),
      alpha: 0.9,
    });
    if (isPlayer) {
      this.eye.circle(0, 0, er * 0.4).fill({ color: C.chase, alpha: 0.85 });
    }

    // --- win-arena hold timer, a ring around your storm --------------------
    this.holdRing.clear();
    if (s.winTimer > 0) {
      const t = Math.min(1, s.winTimer / WIN_HOLD_TIME);
      const rr = fr * z * 1.14;
      this.holdRing.arc(0, 0, rr, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
      this.holdRing.stroke({ width: Math.max(3, rr * 0.05), color: C.crown, cap: 'round' });
    }

    // --- label --------------------------------------------------------------
    const showName = !isPlayer && (rank >= 3 || s.isLaNina);
    this.label.visible = showName;
    if (showName) {
      if (this.lastName !== s.name) {
        this.label.text = s.name;
        this.lastName = s.name;
      }
      this.label.y = -(fr * z + 10);
      this.label.scale.set(Math.min(1.2, Math.max(0.6, z)));
      this.label.tint = s.isLaNina ? 0x7fd0ff : rank >= RANK_EL_NINO ? C.crown : C.stormLit;
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

export class StormsView {
  readonly layer = new Container();
  private views = new Map<number, StormView>();

  constructor(private art: Art) {}

  update(storms: Storm[], playerId: number, cam: Camera, time: number, reduced: boolean): void {
    for (let i = 0; i < storms.length; i++) {
      const s = storms[i];
      const fr = fieldRadius(s.mass);
      const show = s.alive && cam.visible(s.x, s.y, fr + 120);
      let v = this.views.get(s.id);

      if (!show) {
        if (v !== undefined) v.root.visible = false;
        continue;
      }
      if (v === undefined) {
        v = new StormView(this.art);
        this.views.set(s.id, v);
        this.layer.addChild(v.root);
      }
      v.root.visible = true;
      v.update(s, cam, s.id === playerId, time, reduced);
    }
    // Keep the player's storm on top of every rival.
    const pv = this.views.get(playerId);
    if (pv !== undefined) this.layer.setChildIndex(pv.root, this.layer.children.length - 1);
  }

  reset(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.layer.removeChildren();
  }
}
