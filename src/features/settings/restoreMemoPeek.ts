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

/** Efface le mémo de l'issue (revue du lot F : APRÈS le nettoyage de la file N-03 quand l'appareil en a une). */
export function settleRestoreMemo(): void {
  try {
    globalThis.localStorage?.removeItem(RESTORE_RESULT_KEY);
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

/**
 * P-04-iOS critère 7 : issue de la restauration mémorisée avant le redémarrage (relance PC, rechargement iPhone), dite UNE fois après
 * (message et entrée au journal `restore-done` / `restore-failed`). Revue du lot F : avec une file d'actions N-03 (`actionQueue`), une
 * restauration aboutie garde son mémo (marqué `announced`) jusqu'au nettoyage de la file (`settleRestoreMemo`, `notificationActions.ts`) :
 * un arrêt avant lui refait le nettoyage au lancement suivant, sans redire l'issue. Sinon, le mémo est effacé tout de suite.
 */
export function announcePendingRestore(options: { readonly actionQueue: boolean } = { actionQueue: false }): void {
  const raw = item(RESTORE_RESULT_KEY);
  if (raw === null) return;
  let memo: { outcome?: unknown; reason?: unknown; announced?: unknown } = {};
  try {
    memo = JSON.parse(raw) as typeof memo;
  } catch {
    memo = { outcome: 'failed', reason: 'unreadable' };
  }
  if (memo.outcome === 'done' && options.actionQueue) {
    restored = true;
    if (memo.announced === true) return;
    try {
      globalThis.localStorage.setItem(RESTORE_RESULT_KEY, JSON.stringify({ ...memo, announced: true }));
    } catch {
      // Stockage indisponible : l'issue pourrait être redite au lancement suivant, jamais perdue.
    }
    logFailure('backup', 'restore-done');
    useNoticeStore.getState().show(t('backup.resultDone'));
    return;
  }
  settleRestoreMemo();
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
