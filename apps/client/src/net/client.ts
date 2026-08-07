/**
 * Client netcode.
 *
 * Three rules, all from the brief, all load-bearing:
 *
 * PREDICT MOVEMENT ONLY. The local storm's motion is deterministic given its
 * input, so we run the same integration locally and reconcile against
 * snapshots with error smoothing. We do NOT predict mass, absorption or
 * collisions - those apply only when the server says so. A 100ms delay on "I
 * ate that" is invisible; an un-eat is infuriating.
 *
 * INTERPOLATE EVERYONE ELSE, 100ms in the past. Standard buffer-and-render-
 * behind. No lag compensation and no rewind: debris fields are large and slow
 * relative to 100ms, so present-time server-authoritative collision is
 * accurate enough and it saves an entire class of "he killed me from around
 * the corner" bugs. That is a deliberate choice, not an omission.
 *
 * WRAPPING IS THE TRAP. Positions on the wire are absolute in [0, WORLD_W).
 * Every consumer here resolves an entity to the representation nearest the
 * camera before it is used for anything.
 */

import {
  Flag,
  Msg,
  Reader,
  Writer,
  readEvents,
  readRoster,
  readSnapshot,
  readWelcome,
  writeInput,
  EVENT_NAME,
  type NetEntity,
  type RosterEntry,
  type Welcome,
} from '@sen/protocol';
import { wrapDeltaX, wrapX } from '@sen/sim/sim/constants.ts';

/** Render this far in the past, so there is always a pair to interpolate. */
const INTERP_DELAY_MS = 100;
/** Reconciliation error is bled off over this long rather than snapped. */
const SMOOTH_MS = 150;
const INPUT_HZ = 30;

interface Frame {
  tick: number;
  at: number;
  entities: Map<number, NetEntity>;
}

export interface NetStorm {
  id: number;
  x: number;
  y: number;
  ang: number;
  mass: number;
  flags: number;
  name: string;
  human: boolean;
}

export type NetStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error';

export class NetClient {
  private ws: WebSocket | null = null;
  private writer = new Writer(64);
  private frames: Frame[] = [];
  private baseline: Map<number, NetEntity> | null = null;
  private roster = new Map<number, RosterEntry>();
  private seq = 0;
  private inputTimer = 0;

  /** Local prediction of our own storm, and the error being smoothed out. */
  private predX = 0;
  private predY = 0;
  private predAng = 0;
  private errX = 0;
  private errY = 0;
  private errAt = 0;

  welcome: Welcome | null = null;
  status: NetStatus = 'idle';
  selfId = -1;
  /** Round-trip time in ms, measured with the ping/pong pair. */
  rtt = 0;
  lastError = '';

  /** Gameplay events the server published, drained by the caller each frame. */
  events: { type: string; storm: number; x: number; y: number; a: number }[] = [];

  onWelcome: ((w: Welcome) => void) | null = null;

  connect(url: string, name: string): void {
    this.status = 'connecting';
    const ws = new WebSocket(`${url}/play?name=${encodeURIComponent(name)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.pingTimer = window.setInterval(() => this.ping(), 2000);
    };
    ws.onerror = () => {
      this.status = 'error';
      this.lastError = 'socket error';
    };
    ws.onclose = () => {
      this.status = 'closed';
      if (this.pingTimer !== 0) window.clearInterval(this.pingTimer);
    };
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => this.onMessage(new Uint8Array(ev.data));
  }

  private pingTimer = 0;

  disconnect(): void {
    if (this.pingTimer !== 0) window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    this.status = 'idle';
    this.frames.length = 0;
    this.baseline = null;
  }

  private ping(): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.writer.reset();
    this.writer.u8(Msg.Ping);
    this.writer.u32(performance.now() & 0xffffffff);
    this.ws.send(this.writer.bytes().slice());
  }

  private onMessage(bytes: Uint8Array): void {
    const r = new Reader(bytes);
    const type = r.u8();

    if (type === Msg.Welcome) {
      this.welcome = readWelcome(r);
      this.selfId = this.welcome.selfId;
      this.status = 'live';
      this.onWelcome?.(this.welcome);
      return;
    }

    if (type === Msg.Snapshot) {
      const snap = readSnapshot(r, this.baseline);
      const map = new Map<number, NetEntity>();
      for (const e of snap.entities) map.set(e.id, e);
      // Removals are applied against the baseline the delta was built on.
      if (this.baseline !== null) {
        for (const [id, e] of this.baseline) {
          if (!map.has(id) && !snap.removed.includes(id)) map.set(id, e);
        }
      }
      this.baseline = map;
      this.selfId = snap.head.selfId;

      this.frames.push({ tick: snap.head.tick, at: performance.now(), entities: map });
      // Two seconds of history is far more than the 100ms window needs and
      // still enough to ride out a stall.
      while (this.frames.length > 2 * 15 * 2) this.frames.shift();

      this.reconcile(map.get(snap.head.selfId));
      return;
    }

    if (type === Msg.Roster) {
      this.roster.clear();
      for (const e of readRoster(r)) this.roster.set(e.id, e);
      return;
    }

    if (type === Msg.Events) {
      for (const e of readEvents(r)) {
        const name = EVENT_NAME[e.type];
        if (name !== undefined) {
          this.events.push({ type: name, storm: e.storm, x: e.x, y: e.y, a: e.a });
        }
      }
      return;
    }

    if (type === Msg.Pong) {
      const sent = r.u32();
      this.rtt = (performance.now() & 0xffffffff) - sent;
      return;
    }
  }

  // ------------------------------------------------------------- prediction

  /**
   * Seed the predictor. Called once when the run starts, and after any
   * teleport the server imposes (a shred knockback, a respawn).
   */
  resetPrediction(x: number, y: number, ang: number): void {
    this.predX = x;
    this.predY = y;
    this.predAng = ang;
    this.errX = 0;
    this.errY = 0;
  }

  /**
   * Advance the local prediction using the same integration the sim uses.
   *
   * Movement only. Mass is whatever the last snapshot said it was.
   */
  predict(dt: number, integrate: (x: number, y: number, ang: number, dt: number) => [number, number, number]): void {
    const [nx, ny, na] = integrate(this.predX, this.predY, this.predAng, dt);
    this.predX = wrapX(nx);
    this.predY = ny;
    this.predAng = na;
  }

  /** Where to draw the local storm: prediction plus the error still bleeding off. */
  predicted(): { x: number; y: number; ang: number } {
    const age = performance.now() - this.errAt;
    const k = age >= SMOOTH_MS ? 0 : 1 - age / SMOOTH_MS;
    return {
      x: wrapX(this.predX + this.errX * k),
      y: this.predY + this.errY * k,
      ang: this.predAng,
    };
  }

  /**
   * Fold a server correction into the smoothing offset rather than snapping.
   *
   * A hard snap on every packet is what makes netcode feel like netcode. The
   * error is measured through wrapDeltaX, because the one place this would
   * explode is a correction that straddles the seam.
   */
  private reconcile(self: NetEntity | undefined): void {
    if (self === undefined) return;
    const dx = wrapDeltaX(this.predX, self.x);
    const dy = self.y - this.predY;
    const dist = Math.hypot(dx, dy);

    if (dist > 900) {
      // Too far to smooth: this is a knockback, a respawn or a reconnect, and
      // pretending otherwise would slide the storm across a continent.
      this.resetPrediction(self.x, self.y, self.ang);
      return;
    }

    // Keep drawing where we are now, then walk to the truth over SMOOTH_MS.
    const shown = this.predicted();
    this.predX = self.x;
    this.predY = self.y;
    this.errX = wrapDeltaX(this.predX, shown.x);
    this.errY = shown.y - this.predY;
    this.errAt = performance.now();
  }

  // ---------------------------------------------------------- interpolation

  /**
   * Every remote storm, interpolated 100ms in the past.
   *
   * Positions come back absolute; the caller resolves them against its camera.
   */
  interpolated(out: NetStorm[]): NetStorm[] {
    out.length = 0;
    const target = performance.now() - INTERP_DELAY_MS;

    let older: Frame | null = null;
    let newer: Frame | null = null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].at <= target) {
        older = this.frames[i];
        newer = this.frames[i + 1] ?? null;
        break;
      }
    }
    if (older === null) {
      older = this.frames[0] ?? null;
      newer = this.frames[1] ?? null;
    }
    if (older === null) return out;

    const span = newer === null ? 0 : newer.at - older.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (target - older.at) / span)) : 0;

    for (const [id, a] of older.entities) {
      if ((a.flags & Flag.Debris) !== 0) continue;
      const b = newer?.entities.get(id);
      const meta = this.roster.get(id);

      let x = a.x;
      let y = a.y;
      let ang = a.ang;
      if (b !== undefined) {
        // Interpolate along the short way round the world, not through it.
        x = wrapX(a.x + wrapDeltaX(a.x, b.x) * t);
        y = a.y + (b.y - a.y) * t;
        const da = Math.atan2(Math.sin(b.ang - a.ang), Math.cos(b.ang - a.ang));
        ang = a.ang + da * t;
      }

      out.push({
        id,
        x,
        y,
        ang,
        mass: b?.mass ?? a.mass,
        flags: b?.flags ?? a.flags,
        name: meta?.name ?? '',
        human: meta?.human ?? false,
      });
    }
    return out;
  }

  /** Loose debris, same treatment. */
  interpolatedDebris(out: NetEntity[]): NetEntity[] {
    out.length = 0;
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) return out;
    for (const e of frame.entities.values()) {
      if ((e.flags & Flag.Debris) !== 0) out.push(e);
    }
    return out;
  }

  // ------------------------------------------------------------------ input

  /** Called every frame; sends at 30Hz. This is the whole authority surface. */
  sendInput(dt: number, steerAngle: number, boosting: boolean): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.inputTimer += dt;
    if (this.inputTimer < 1 / INPUT_HZ) return;
    this.inputTimer = 0;
    this.writer.reset();
    writeInput(this.writer, { seq: this.seq++ & 0xffff, steerAngle, boosting });
    this.ws.send(this.writer.bytes().slice());
  }

  /** Tell the server how much world we can draw, so AOI matches the viewport. */
  sendViewport(w: number, h: number): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    this.writer.reset();
    this.writer.u8(Msg.Roster);
    this.writer.u16(Math.round(w));
    this.writer.u16(Math.round(h));
    this.ws.send(this.writer.bytes().slice());
  }

  /** Everyone the server says is human in this instance, ourselves included. */
  humans(): RosterEntry[] {
    return [...this.roster.values()].filter((e) => e.human);
  }

  drainEvents(): typeof this.events {
    if (this.events.length === 0) return [];
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
}
