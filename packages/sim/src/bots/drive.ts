/**
 * Fills the per-tick input map. Every bot gets its own persistent Input object
 * so nothing is aliased, and the player's Input drops into the same map -
 * from the sim's point of view they are the same thing.
 */

import { FIXED_DT } from '../sim/constants.ts';
import type { Input, WorldState } from '../sim/types.ts';
import { botInput } from './brain.ts';

export class InputCollector {
  readonly map = new Map<number, Input>();

  private get(id: number): Input {
    let i = this.map.get(id);
    if (i === undefined) {
      i = { steerAngle: 0, boosting: false };
      this.map.set(id, i);
    }
    return i;
  }

  /** Set the human's input. Same shape a socket would deliver. */
  setPlayer(id: number, steerAngle: number, boosting: boolean): void {
    const i = this.get(id);
    i.steerAngle = steerAngle;
    i.boosting = boosting;
  }

  /** Run every bot brain and collect their Inputs. */
  collect(w: WorldState): Map<number, Input> {
    for (let i = 0; i < w.storms.length; i++) {
      const s = w.storms[i];
      if (s.kind !== 'bot' || !s.alive) continue;
      botInput(w, s, FIXED_DT, this.get(s.id));
    }
    return this.map;
  }
}
