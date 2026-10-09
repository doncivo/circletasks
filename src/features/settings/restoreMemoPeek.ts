import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import { useNoticeStore } from '../app/notice';

/**
 * Lecture minimale des mémos de la restauration au démarrage (bundle de départ) : la présence d'une issue à annoncer et le code du
 * marqueur non écrit. Le reste (écriture, lecture complète) est dans `restoreMemo.ts`, chargé à la demande. Mêmes clés.
 */
export const RESTORE_RESULT_KEY = 'ct.restore.result';
export const MARKER_FAILED_KEY = 'ct.restore.markerFailed';

let restored = false;

/** Une restauration a abouti juste avant ce lancement (P-04-iOS critère 14 : la file N-03 est alors nettoyée des cibles inconnues). */
export function restoredThisLaunch(): boolean {
  return restored;
}

function item(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Code du marqueur de restauration non écrit, ou null (mémo absent). Mémo illisible : `unknown` (jamais ignoré). */
export function peekMarkerFailedCode(): string | null {
  const raw = item(MARKER_FAILED_KEY);
  if (raw === null) return null;
  try {
    const code = (JSON.parse(raw) as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Efface le mémo du marqueur (résolu, ou « Reprendre la synchronisation »). */
export function clearMarkerFailedMemo(): void {
  try {
    globalThis.localStorage?.removeItem(MARKER_FAILED_KEY);
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

/**
 * P-04-iOS critère 7 : issue de la restauration mémorisée avant le redémarrage (relance PC, rechargement iPhone), dite UNE fois après
 * (message et entrée au journal `restore-done` / `restore-failed`), puis effacée.
 */
export function announcePendingRestore(): void {
  const raw = item(RESTORE_RESULT_KEY);
  if (raw === null) return;
  try {
    globalThis.localStorage.removeItem(RESTORE_RESULT_KEY);
  } catch {
    // Stockage indisponible : l'issue est dite une fois quand même.
  }
  let memo: { outcome?: unknown; reason?: unknown } = {};
  try {
    memo = JSON.parse(raw) as typeof memo;
  } catch {
    memo = { outcome: 'failed', reason: 'unreadable' };
  }
  if (memo.outcome === 'done') {
    restored = true;
    logFailure('backup', 'restore-done');
    useNoticeStore.getState().show(t('backup.resultDone'));
    return;
  }
  const code = typeof memo.reason === 'string' ? memo.reason : 'io';
  logFailure('backup', `restore-failed ${code}`);
  useNoticeStore.getState().show(t('backup.resultFailed', { code }));
}
