import { createLogJournal, type LogJournalEnv } from './buffer';
import { createMemoryLogTransport } from './memory';
import { createTauriLogTransport } from './tauriLogs';
import type { LogJournal, LogTransport } from './types';

export { createLogJournal, type LogJournalEnv } from './buffer';
export { createMemoryLogTransport, type MemoryLogTransport } from './memory';
export { codeAndDetailOf, LOG_MASK, normalizeScope, sanitizeLogDetail } from './sanitize';
export { categoryOf, LOG_BATCH_SIZE, LOG_BUFFER_SIZE, LOG_FLUSH_MS, LOG_READ_MAX, type LogCategory, type LogEntry, type LogJournal, type LogStatus, type LogTransport } from './types';

/**
 * Journal de la fenêtre courante (ADR 0014 §3) : seule la fenêtre `main` de l'app installée (PC et iPhone) écrit dans le fichier ; les
 * autres fenêtres du PC (Focus) gardent la session seule, sans capability ni état d'échec ; navigateur de développement : mémoire.
 * En développement, un e2e peut poser `globalThis.__ctLogs` (transport faux, par exemple rempli de 600 entrées) avant le chargement.
 */
export function openLogJournal(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other', windowLabel: string, env: LogJournalEnv = {}): LogJournal {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctLogs?: LogTransport }).__ctLogs;
    if (override) return createLogJournal(override, env);
  }
  if (windowLabel !== 'main') return createLogJournal(null, env);
  if (runtime === 'web') return createLogJournal(createMemoryLogTransport(), env);
  if (os === 'windows' || os === 'ios') return createLogJournal(createTauriLogTransport(), env);
  return createLogJournal(null, env);
}

/** Version de l'app pour l'en-tête de l'export (`@tauri-apps/api/app`, permission `core:default`) ; `dev` dans le navigateur. */
export async function appVersion(runtime: 'tauri' | 'web'): Promise<string> {
  if (runtime === 'web') return 'dev';
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}
