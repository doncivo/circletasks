/**
 * Mémo de la restauration (P-04-iOS, ADR 0009 avenant lot F B6), dans `localStorage` (précédent : `theme.ts`) : il survit au rechargement
 * de la WebView (iPhone) et à la relance (PC), contrairement à l'état de l'interface. Aucun contenu : nom de sauvegarde, codes, instant.
 *
 * - `ct.restore.result` : issue de la dernière restauration, lue UNE fois après le redémarrage (message affiché, entrée au journal), puis
 *   effacée (P-04-iOS critère 7, entrée `restore-done`) ;
 * - `ct.restore.markerFailed` : le marqueur de la synchro n'a pas pu être écrit ; gardé jusqu'à résolution (marqueur réécrit, ou choix
 *   explicite « Reprendre la synchronisation »). Tant qu'il existe, aucun cycle de synchro ne part (critère 12).
 */

export const RESTORE_RESULT_KEY = 'ct.restore.result';
export const MARKER_FAILED_KEY = 'ct.restore.markerFailed';

export interface RestoreResultMemo {
  readonly outcome: 'done' | 'failed';
  readonly reason: string | null;
  readonly databaseClosed: boolean;
  readonly marker: 'written' | 'not-configured' | 'failed' | null;
  readonly markerCode: string | null;
}

export interface MarkerFailedMemo {
  readonly backup: string;
  readonly code: string;
  readonly at: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Écrit un mémo ; faux si le stockage est indisponible (l'appelant le journalise). */
function writeJson(key: string, value: unknown): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

export function writeRestoreResult(memo: RestoreResultMemo): boolean {
  return writeJson(RESTORE_RESULT_KEY, memo);
}

/** Lit l'issue mémorisée et l'efface (lue une seule fois). */
export function takeRestoreResult(): RestoreResultMemo | null {
  const value = readJson(RESTORE_RESULT_KEY);
  remove(RESTORE_RESULT_KEY);
  if (typeof value !== 'object' || value === null) return null;
  const memo = value as Partial<RestoreResultMemo>;
  if (memo.outcome !== 'done' && memo.outcome !== 'failed') return null;
  return {
    outcome: memo.outcome,
    reason: typeof memo.reason === 'string' ? memo.reason : null,
    databaseClosed: memo.databaseClosed === true,
    marker: memo.marker === 'written' || memo.marker === 'not-configured' || memo.marker === 'failed' ? memo.marker : null,
    markerCode: typeof memo.markerCode === 'string' ? memo.markerCode : null,
  };
}

export function writeMarkerFailed(memo: MarkerFailedMemo): boolean {
  return writeJson(MARKER_FAILED_KEY, memo);
}

export function readMarkerFailed(): MarkerFailedMemo | null {
  const value = readJson(MARKER_FAILED_KEY);
  if (typeof value !== 'object' || value === null) return null;
  const memo = value as Partial<MarkerFailedMemo>;
  return { backup: typeof memo.backup === 'string' ? memo.backup : '', code: typeof memo.code === 'string' ? memo.code : 'unknown', at: typeof memo.at === 'string' ? memo.at : '' };
}

export function clearMarkerFailed(): void {
  remove(MARKER_FAILED_KEY);
}
