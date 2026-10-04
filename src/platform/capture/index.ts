import { detectOs, detectRuntime, type OsFamily, type Runtime } from '../runtime';
import { createMainBridge, createWindowBridge } from './bridge';
import { CAPTURE_WINDOW_LABEL, MAIN_WINDOW_LABEL } from './events';
import { createChannelTransport, createTauriTransport } from './transports';
import type { CaptureMainBridge, CaptureWindowBridge } from './types';

export * from './events';
export { createMainBridge, createWindowBridge } from './bridge';
export { CHANNEL_NAME, createChannelTransport, createMemoryBus, createTauriTransport } from './transports';
export type {
  CaptureContextSnapshot,
  CaptureError,
  CaptureMainBridge,
  CaptureOutcome,
  CaptureReply,
  CaptureSubmit,
  CaptureTransport,
  CaptureWindowBridge,
  Unlisten,
} from './types';

/** Drapeau posé par Playwright (`addInitScript`) pour relier deux onglets du navigateur de développement. Jamais posé en production. */
const CHANNEL_FLAG = '__CT_CAPTURE_CHANNEL__';

function channelEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[CHANNEL_FLAG] === true;
}

/**
 * Pont de la fenêtre principale : app PC installée (événements Tauri), ou navigateur de développement quand le drapeau de test est posé ;
 * `null` ailleurs (iPhone, navigateur ordinaire, tests unitaires).
 */
export function openCaptureMainBridge(runtime: Runtime = detectRuntime(), os: OsFamily = detectOs()): CaptureMainBridge | null {
  if (runtime === 'tauri') return os === 'windows' ? createMainBridge(createTauriTransport()) : null;
  return channelEnabled() ? createMainBridge(createChannelTransport(MAIN_WINDOW_LABEL)) : null;
}

/** Pont de la mini-fenêtre (point d'entrée `capture.html`) : toujours disponible, le transport dépend de l'environnement. */
export function openCaptureWindowBridge(runtime: Runtime = detectRuntime()): CaptureWindowBridge {
  return createWindowBridge(runtime === 'tauri' ? createTauriTransport('window') : createChannelTransport(CAPTURE_WINDOW_LABEL));
}
