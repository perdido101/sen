/**
 * @sen/protocol - the wire format, defined once and imported by both ends.
 *
 * Two rules hold this together:
 *
 * 1. The client->server packet has room for a heading and a boost bit and
 *    NOTHING ELSE. A modified client cannot express "I have 5000 mass"
 *    because the format has no field for it. This kills most cheating by
 *    construction rather than by detection. Never add a field to it.
 *
 * 2. Server->client is binary, quantised and delta-compressed against the
 *    last snapshot the client acknowledged. A naive full-state broadcast of
 *    this world is roughly a hundred times over budget.
 */

import { WORLD_H, WORLD_W } from '@sen/sim/sim/constants.ts';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Message ids
// ---------------------------------------------------------------------------

export const Msg = {
  /** server -> client, once on join */
  Welcome: 1,
  /** server -> client, 15Hz */
  Snapshot: 2,
  /** client -> server, 30Hz */
  Input: 3,
  /** server -> client, names and joins/leaves - rare, so not in the hot path */
  Roster: 4,
  /** server -> client, gameplay events worth a sound or a particle */
  Events: 5,
  /** either direction */
  Ping: 6,
  Pong: 7,
} as const;

// ---------------------------------------------------------------------------
// Quantisation
//
// Positions are absolute in [0, WORLD_W) x [0, WORLD_H) and quantised into a
// uint16 each. At the current world size that is WORLD_W/65536 = 0.25 units of
// precision horizontally and 0.125 vertically - finer than a storm's eye by
// two orders of magnitude, and far finer than the 100ms interpolation window
// smooths over anyway.
// ---------------------------------------------------------------------------

export const POS_X_SCALE = 65536 / WORLD_W;
export const POS_Y_SCALE = 65536 / WORLD_H;
export const ANG_SCALE = 256 / (Math.PI * 2);

export function packX(x: number): number {
  return Math.round(x * POS_X_SCALE) & 0xffff;
}
export function unpackX(v: number): number {
  return v / POS_X_SCALE;
}
export function packY(y: number): number {
  const q = Math.round(y * POS_Y_SCALE);
  return q < 0 ? 0 : q > 65535 ? 65535 : q;
}
export function unpackY(v: number): number {
  return v / POS_Y_SCALE;
}
/** Angle to a byte: 1.4 degrees, which is finer than a storm can turn in a tick. */
export function packAngle(a: number): number {
  let t = a % (Math.PI * 2);
  if (t < 0) t += Math.PI * 2;
  return Math.round(t * ANG_SCALE) & 0xff;
}
export function unpackAngle(v: number): number {
  const a = v / ANG_SCALE;
  return a > Math.PI ? a - Math.PI * 2 : a;
}
/** Mass is linear in a uint16; the ladder tops out at 5000 and this holds 65535. */
export function packMass(m: number): number {
  const q = Math.round(m);
  return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

// ---------------------------------------------------------------------------
// Entity flags
// ---------------------------------------------------------------------------

export const Flag = {
  Boosting: 1 << 0,
  /** Southern hemisphere, so the client spins the field the right way. */
  Southern: 1 << 1,
  Invuln: 1 << 2,
  LaNina: 1 << 3,
  /** Draining a city: drives the siren and the slowdown read. */
  Draining: 1 << 4,
  /** Debris rather than a storm. */
  Debris: 1 << 5,
  /**
   * Dissipated. Only ever set on the receiving client's own storm: everyone
   * else simply stops being sent. Without it a client cannot tell "I died"
   * from "I flew out of my own area of interest", and the game-over card
   * never appears.
   */
  Dead: 1 << 6,
} as const;

// Delta field mask.
export const Field = {
  X: 1 << 0,
  Y: 1 << 1,
  Ang: 1 << 2,
  Mass: 1 << 3,
  Flags: 1 << 4,
  /** Set on an entity the client has never seen: everything is present. */
  Spawn: 1 << 7,
} as const;

export interface NetEntity {
  id: number;
  x: number;
  y: number;
  ang: number;
  mass: number;
  flags: number;
}

// ---------------------------------------------------------------------------
// Writer / reader
// ---------------------------------------------------------------------------

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private off = 0;

  constructor(capacity = 16384) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private need(n: number): void {
    if (this.off + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.off + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.need(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
  }
  u16(v: number): void {
    this.need(2);
    this.view.setUint16(this.off, v & 0xffff);
    this.off += 2;
  }
  u32(v: number): void {
    this.need(4);
    this.view.setUint32(this.off, v >>> 0);
    this.off += 4;
  }
  f32(v: number): void {
    this.need(4);
    this.view.setFloat32(this.off, v);
    this.off += 4;
  }
  str(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.u8(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.off);
    this.off += bytes.length;
  }

  reset(): void {
    this.off = 0;
  }
  get length(): number {
    return this.off;
  }
  /** A view over the written bytes. Copy it if it must outlive the next write. */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.off);
  }
}

export class Reader {
  private view: DataView;
  private off = 0;

  private buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.off++);
  }
  u16(): number {
    const v = this.view.getUint16(this.off);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off);
    this.off += 4;
    return v;
  }
  str(): string {
    const n = this.u8();
    const s = new TextDecoder().decode(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return s;
  }
  get done(): boolean {
    return this.off >= this.buf.length;
  }
  get offset(): number {
    return this.off;
  }
}

// ---------------------------------------------------------------------------
// Client -> server input. The entire client authority surface: 5 bytes.
// ---------------------------------------------------------------------------

export interface InputPacket {
  seq: number;
  steerAngle: number;
  boosting: boolean;
}

export function writeInput(w: Writer, p: InputPacket): void {
  w.u8(Msg.Input);
  w.u16(p.seq & 0xffff);
  w.u8(packAngle(p.steerAngle));
  w.u8(p.boosting ? 1 : 0);
}

export function readInput(r: Reader): InputPacket {
  const seq = r.u16();
  const steerAngle = unpackAngle(r.u8());
  const boosting = r.u8() !== 0;
  return { seq, steerAngle, boosting };
}

// ---------------------------------------------------------------------------
// Server -> client snapshot, delta-compressed against a baseline
// ---------------------------------------------------------------------------

export interface SnapshotHeader {
  tick: number;
  /** Which input seq the server had consumed when this was produced. */
  ackSeq: number;
  /** Baseline this delta is against; 0 means a full snapshot. */
  baseTick: number;
  /** The client's own entity id, so it can find itself without a name lookup. */
  selfId: number;
}

/**
 * Encode a snapshot as a delta against `baseline`.
 *
 * @param baseline the last snapshot this client acknowledged, or null for a
 *                 full one. Entities missing from `entities` but present in
 *                 the baseline are sent as removals.
 */
export function writeSnapshot(
  w: Writer,
  head: SnapshotHeader,
  entities: NetEntity[],
  baseline: Map<number, NetEntity> | null,
): void {
  w.u8(Msg.Snapshot);
  w.u32(head.tick);
  w.u16(head.ackSeq);
  w.u32(head.baseTick);
  w.u16(head.selfId);

  // Removals first: the client can drop them before reading the rest.
  const removed: number[] = [];
  if (baseline !== null) {
    const live = new Set<number>();
    for (const e of entities) live.add(e.id);
    for (const id of baseline.keys()) if (!live.has(id)) removed.push(id);
  }
  w.u16(removed.length);
  for (const id of removed) w.u16(id);

  w.u16(entities.length);
  for (const e of entities) {
    const b = baseline?.get(e.id);
    let mask = 0;
    const qx = packX(e.x);
    const qy = packY(e.y);
    const qa = packAngle(e.ang);
    const qm = packMass(e.mass);

    if (b === undefined) {
      mask = Field.Spawn | Field.X | Field.Y | Field.Ang | Field.Mass | Field.Flags;
    } else {
      if (packX(b.x) !== qx) mask |= Field.X;
      if (packY(b.y) !== qy) mask |= Field.Y;
      if (packAngle(b.ang) !== qa) mask |= Field.Ang;
      if (packMass(b.mass) !== qm) mask |= Field.Mass;
      if (b.flags !== e.flags) mask |= Field.Flags;
    }

    w.u16(e.id);
    w.u8(mask);
    if (mask & Field.X) w.u16(qx);
    if (mask & Field.Y) w.u16(qy);
    if (mask & Field.Ang) w.u8(qa);
    if (mask & Field.Mass) w.u16(qm);
    if (mask & Field.Flags) w.u8(e.flags);
  }
}

export interface DecodedSnapshot {
  head: SnapshotHeader;
  removed: number[];
  /** Entities with deltas already applied against the supplied baseline. */
  entities: NetEntity[];
}

export function readSnapshot(
  r: Reader,
  baseline: Map<number, NetEntity> | null,
): DecodedSnapshot {
  const head: SnapshotHeader = {
    tick: r.u32(),
    ackSeq: r.u16(),
    baseTick: r.u32(),
    selfId: r.u16(),
  };

  const removedCount = r.u16();
  const removed: number[] = [];
  for (let i = 0; i < removedCount; i++) removed.push(r.u16());

  const count = r.u16();
  const entities: NetEntity[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.u16();
    const mask = r.u8();
    const prev = baseline?.get(id);
    const e: NetEntity = {
      id,
      x: prev?.x ?? 0,
      y: prev?.y ?? 0,
      ang: prev?.ang ?? 0,
      mass: prev?.mass ?? 0,
      flags: prev?.flags ?? 0,
    };
    if (mask & Field.X) e.x = unpackX(r.u16());
    if (mask & Field.Y) e.y = unpackY(r.u16());
    if (mask & Field.Ang) e.ang = unpackAngle(r.u8());
    if (mask & Field.Mass) e.mass = r.u16();
    if (mask & Field.Flags) e.flags = r.u8();
    entities.push(e);
  }

  return { head, removed, entities };
}

// ---------------------------------------------------------------------------
// Welcome / roster / events
// ---------------------------------------------------------------------------

export interface Welcome {
  version: number;
  selfId: number;
  seed: number;
  worldW: number;
  worldH: number;
  tickRate: number;
  snapshotRate: number;
  instance: string;
}

export function writeWelcome(w: Writer, m: Welcome): void {
  w.u8(Msg.Welcome);
  w.u8(m.version);
  w.u16(m.selfId);
  w.u32(m.seed >>> 0);
  w.u32(m.worldW);
  w.u32(m.worldH);
  w.u8(m.tickRate);
  w.u8(m.snapshotRate);
  w.str(m.instance);
}

export function readWelcome(r: Reader): Welcome {
  return {
    version: r.u8(),
    selfId: r.u16(),
    seed: r.u32(),
    worldW: r.u32(),
    worldH: r.u32(),
    tickRate: r.u8(),
    snapshotRate: r.u8(),
    instance: r.str(),
  };
}

export interface RosterEntry {
  id: number;
  name: string;
  human: boolean;
}

export function writeRoster(w: Writer, entries: RosterEntry[]): void {
  w.u8(Msg.Roster);
  w.u16(entries.length);
  for (const e of entries) {
    w.u16(e.id);
    w.u8(e.human ? 1 : 0);
    w.str(e.name);
  }
}

export function readRoster(r: Reader): RosterEntry[] {
  const n = r.u16();
  const out: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: r.u16(), human: r.u8() !== 0, name: r.str() });
  }
  return out;
}

export interface NetEvent {
  type: number;
  storm: number;
  x: number;
  y: number;
  a: number;
}

export function writeEvents(w: Writer, events: NetEvent[]): void {
  w.u8(Msg.Events);
  w.u16(events.length);
  for (const e of events) {
    w.u8(e.type);
    w.u16(e.storm);
    w.u16(packX(e.x));
    w.u16(packY(e.y));
    w.f32(e.a);
  }
}

export function readEvents(r: Reader): NetEvent[] {
  const n = r.u16();
  const out: NetEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: r.u8(),
      storm: r.u16(),
      x: unpackX(r.u16()),
      y: unpackY(r.u16()),
      a: r.f32(),
    });
  }
  return out;
}

/** Stable ids for the SimEvent types worth putting on the wire. */
export const EVENT_ID: Record<string, number> = {
  absorb: 1,
  shred: 2,
  eyeHit: 3,
  dissipate: 4,
  rankUp: 5,
  cityEmptied: 6,
  buildingCollapse: 7,
  equatorCross: 8,
  boostEject: 9,
  win: 10,
  cityDrainStart: 11,
  cityDrainStop: 12,
  chaser: 13,
};
export const EVENT_NAME: string[] = [];
for (const k of Object.keys(EVENT_ID)) EVENT_NAME[EVENT_ID[k]] = k;
