import { detectOs, detectRuntime, type OsFamily, type Runtime } from '../runtime';
import type { FocusWindowClient, FocusWindowPlatform } from './types';

export * from './constants';
export { createMemoryFocusWindow, type MemoryFocusWindow } from './memory';
export { createFakeFocusEndScheduler, createNoopFocusEndScheduler, type FakeFocusEndScheduler, type FakeSchedulerCall } from './endScheduler';
export { createFakeSoundPlayer, createHtmlAudioPlayer, type FakeSoundPlayer } from './sound';
export type {
  FocusPhase,
  FocusEndScheduler,
  FocusWindowAction,
  FocusWindowClient,
  FocusWindowPlatform,
  FocusWindowPosition,
  FocusWindowState,
  SoundPlayer,
} from './types';

/**
 * Mini-fenêtre Focus du PC : implémentation Tauri sur Windows installé, `null` ailleurs (navigateur, Playwright, iPhone : la
 * session s'affiche alors dans la fenêtre principale). Import dynamique : l'API fenêtres n'est chargée que dans l'app PC.
 */
export async function openFocusWindowPlatform(runtime: Runtime = detectRuntime(), os: OsFamily = detectOs()): Promise<FocusWindowPlatform | null> {
  if (runtime !== 'tauri' || os !== 'windows') return null;
  const { createTauriFocusWindow } = await import('./tauriFocusWindow');
  return createTauriFocusWindow();
}

/** Côté mini-fenêtre : `null` hors Tauri (la vue n'est alors jamais lancée seule). */
export async function openFocusWindowClient(runtime: Runtime = detectRuntime()): Promise<FocusWindowClient | null> {
  if (runtime !== 'tauri') return null;
  const { createTauriFocusClient } = await import('./tauriFocusWindow');
  return createTauriFocusClient();
}
