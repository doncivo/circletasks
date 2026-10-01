import { isTauri } from '@tauri-apps/api/core';

/**
 * Environnement d'exécution. Seul src/platform le détecte ; le reste du code
 * reçoit des abstractions (ADR 0001).
 * - 'tauri' : app installée (Windows ou iOS) ;
 * - 'web'   : navigateur de développement (npm run dev, Playwright) ou Vitest.
 */
export type Runtime = 'tauri' | 'web';

/** Système cible, utile pour les écarts PC / iPhone non couverts par la mise en page. */
export type OsFamily = 'windows' | 'ios' | 'other';

export function detectRuntime(): Runtime {
  return isTauri() ? 'tauri' : 'web';
}

export function detectOs(userAgent: string = globalThis.navigator?.userAgent ?? ''): OsFamily {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Windows/i.test(userAgent)) return 'windows';
  return 'other';
}
