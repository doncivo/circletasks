import { detectRuntime, type Runtime } from '../runtime';
import { createMemoryCalendarPlatform, type MemoryPlatformOptions } from './memory';
import type { CalendarEndpoints, CalendarPlatform } from './types';

export * from './types';
export { MemorySecretVault, createMemoryCalendarPlatform, type MemoryPlatformOptions } from './memory';

/**
 * Plateforme d'agendas (ADR 0008) : commandes Rust dans l'app installée (PC et iPhone, même code), mémoire + simulateurs ailleurs.
 * `simulatorEndpoints` : URL des simulateurs (tests/sim) pour le navigateur de dev et Playwright.
 */
export async function openCalendarPlatform(simulatorEndpoints: CalendarEndpoints, runtime: Runtime = detectRuntime(), options: MemoryPlatformOptions = {}): Promise<CalendarPlatform> {
  if (runtime === 'tauri') {
    const { createTauriCalendarPlatform } = await import('./tauriCalendars');
    return createTauriCalendarPlatform();
  }
  return createMemoryCalendarPlatform(simulatorEndpoints, options);
}
