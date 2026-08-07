/**
 * Service worker registration. There is no server behind this game, so the
 * only thing offline mode has to do is exist.
 */

import { registerSW as register } from 'virtual:pwa-register';

export function registerSW(): void {
  if (import.meta.env.DEV) return;
  try {
    register({ immediate: true });
  } catch {
    // Unsupported browser: the game still runs, it just will not install.
  }
}
