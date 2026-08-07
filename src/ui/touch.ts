/**
 * Touch controls: a transparent floating stick and a boost button.
 *
 * Only ever present on a touch device. A desktop browser never sees them -
 * the check is the pointer's coarseness, not the screen width, so a small
 * window on a laptop still gets the mouse, and a tablet still gets the stick.
 *
 * The stick floats: the base re-centres wherever your thumb lands inside the
 * grab zone, rather than making you find a fixed circle you cannot see while
 * your thumb is over it. The visible ring in the corner is a hint for where to
 * put your thumb, not a target you have to hit.
 */

const STICK_RADIUS = 54;
const DEAD_ZONE = 0.22;

export class TouchControls {
  readonly root: HTMLElement;
  private zone: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private boostBtn: HTMLElement;

  /** Target heading in radians, or null when the stick is not held. */
  angle: number | null = null;
  /** 0..1 past the dead zone. */
  magnitude = 0;
  boosting = false;

  private stickId = -1;
  private boostId = -1;
  private baseX = 0;
  private baseY = 0;
  private enabled = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'touch';
    this.root.hidden = true;

    this.zone = document.createElement('div');
    this.zone.className = 'touch-zone';

    this.base = document.createElement('div');
    this.base.className = 'stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.append(this.knob);

    this.boostBtn = document.createElement('div');
    this.boostBtn.className = 'boost-btn';
    this.boostBtn.textContent = '';

    this.root.append(this.zone, this.base, this.boostBtn);
    this.resetBase();

    this.zone.addEventListener('pointerdown', this.stickDown, { passive: false });
    this.zone.addEventListener('pointermove', this.stickMove, { passive: false });
    this.zone.addEventListener('pointerup', this.stickUp);
    this.zone.addEventListener('pointercancel', this.stickUp);

    this.boostBtn.addEventListener('pointerdown', this.boostDown, { passive: false });
    this.boostBtn.addEventListener('pointerup', this.boostUp);
    this.boostBtn.addEventListener('pointercancel', this.boostUp);
  }

  /**
   * Touch controls appear for a coarse primary pointer. A desktop mouse
   * reports 'fine' and gets nothing.
   */
  static isTouchDevice(): boolean {
    if (typeof window === 'undefined') return false;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const anyCoarse = window.matchMedia('(any-pointer: coarse)').matches;
    return coarse || (anyCoarse && (navigator.maxTouchPoints ?? 0) > 0);
  }

  /** Shown only while a run is in progress, and only on a touch device. */
  setActive(on: boolean): void {
    this.enabled = on && TouchControls.isTouchDevice();
    this.root.hidden = !this.enabled;
    if (!this.enabled) this.release();
  }

  get active(): boolean {
    return this.enabled;
  }

  private resetBase(): void {
    // Idle: the hint ring sits in the corner.
    this.base.classList.remove('held');
    this.base.style.left = '';
    this.base.style.top = '';
    this.knob.style.transform = 'translate(-50%, -50%)';
  }

  private release(): void {
    this.stickId = -1;
    this.angle = null;
    this.magnitude = 0;
    this.resetBase();
  }

  private stickDown = (e: PointerEvent): void => {
    if (!this.enabled || this.stickId !== -1) return;
    e.preventDefault();
    this.stickId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    this.baseX = e.clientX;
    this.baseY = e.clientY;
    this.base.classList.add('held');
    this.base.style.left = `${this.baseX}px`;
    this.base.style.top = `${this.baseY}px`;
    this.update(e.clientX, e.clientY);
  };

  private stickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    e.preventDefault();
    this.update(e.clientX, e.clientY);
  };

  private stickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.release();
  };

  private update(x: number, y: number): void {
    const dx = x - this.baseX;
    const dy = y - this.baseY;
    const d = Math.hypot(dx, dy);
    const clamped = Math.min(d, STICK_RADIUS);
    const t = clamped / STICK_RADIUS;

    this.knob.style.transform =
      `translate(calc(-50% + ${(dx / (d || 1)) * clamped}px), ` +
      `calc(-50% + ${(dy / (d || 1)) * clamped}px))`;

    if (t < DEAD_ZONE) {
      // Held but centred: keep the current heading rather than snapping.
      this.magnitude = 0;
      return;
    }
    this.magnitude = (t - DEAD_ZONE) / (1 - DEAD_ZONE);
    this.angle = Math.atan2(dy, dx);
  }

  private boostDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    this.boostId = e.pointerId;
    this.boosting = true;
    this.boostBtn.classList.add('held');
  };

  private boostUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.boostId) return;
    this.boostId = -1;
    this.boosting = false;
    this.boostBtn.classList.remove('held');
  };
}
