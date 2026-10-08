import type { OsFamily, Runtime } from '../runtime';

/**
 * Ouverture de la page de l'app dans Réglages iOS (ADR 0015 écart 6, audit des impasses) : **un seul point d'appel** de la commande Rust
 * de Réglages (`tauriSystemSettings.ts`), partagé par la dictée, le scan (caméra) et, plus tard, Rappels (K-05) et les notifications
 * (N-01). Indépendant du plugin Speech. Absent (PC, navigateur) : aucune action « Ouvrir les réglages » n'est proposée.
 */
export interface SystemSettings {
  /** Ouvre Réglages › CircleTasks ; rejette `SystemSettingsError` (code `settings-open-failed`), jamais un bouton muet. */
  openApp(): Promise<void>;
}

export class SystemSettingsError extends Error {
  readonly code: string;
  constructor(code = 'settings-open-failed', cause?: unknown) {
    super(`Ouverture des réglages impossible (${code})`, { cause });
    this.name = 'SystemSettingsError';
    this.code = code;
  }
}

let current: SystemSettings | null = null;

/** Ouvreur courant, ou `null` (PC, navigateur). */
export function getSystemSettings(): SystemSettings | null {
  return current;
}

/** Branche un ouvreur (iPhone au démarrage, faux dans les tests). `null` retire l'action. */
export function setSystemSettings(settings: SystemSettings | null): void {
  current = settings;
}

/**
 * Résolveur : adaptateur Tauri chargé à la demande pour (`tauri`, `ios`) ; `null` ailleurs. En développement seulement,
 * `globalThis.__ctSystemSettings` (faux de l'e2e) remplace tout ; retiré du build de production.
 */
export function openSystemSettings(runtime: Runtime, os: OsFamily): SystemSettings | null {
  if (import.meta.env.DEV) {
    const injected = (globalThis as { __ctSystemSettings?: SystemSettings }).__ctSystemSettings;
    if (injected) return injected;
  }
  if (runtime === 'tauri' && os === 'ios') {
    return { openApp: async () => (await import('./tauriSystemSettings')).createTauriSystemSettings().openApp() };
  }
  return null;
}
