/**
 * Règles de la restauration d'une valeur écartée par un conflit (Y-04 ; ADR 0011 §4.2, §4.3 ; decisions.md Y-04 D3 et lignes du
 * 2026-10-06). Module pur : la lecture de la base et l'écriture sont faites par `src/features/sync/syncConflictUseCases.ts`.
 */

import type { SyncValue } from './format';
import { MODIFIED_MARKER, sameValue } from './merge';
import { isValidValue, syncColumn, syncTable, type SyncColumn, type SyncTable } from './syncTables';

/** État d'une ligne visée (ou d'un parent visé par une valeur). */
export type ConflictRowState = 'live' | 'deleted' | 'missing' | 'purged';

export type RestoreRefusal = 'row-gone' | 'parent-gone' | 'invalid';

export type RestoreDecision =
  | { readonly kind: 'refused'; readonly reason: RestoreRefusal }
  /** La valeur écartée est déjà en place : aucune écriture, conflit résolu (critère 10). */
  | { readonly kind: 'already' }
  /** Écrire la valeur écartée dans le champ. */
  | { readonly kind: 'write' }
  /** Conflit de suppression : mettre l'élément dans l'état voulu (supprimé ou présent). */
  | { readonly kind: 'element'; readonly deleted: boolean };

/** Table et colonne du catalogue désignées par une ligne de journal ; null si hors catalogue ou champ masqué (critères 2 et 9). */
export function conflictTarget(conflict: { readonly table: string; readonly field: string }): { readonly table: SyncTable; readonly column: SyncColumn } | null {
  const table = syncTable(conflict.table);
  const column = table ? syncColumn(table.name, conflict.field) : undefined;
  if (!table || !column || !column.conflictVisible) return null;
  return { table, column };
}

/** Parent désigné par une colonne (clé étrangère du catalogue). */
export function parentTableOf(table: SyncTable, column: SyncColumn): SyncTable | undefined {
  const relation = table.parents.find((p) => p.column === column.name);
  return relation ? syncTable(relation.table) : undefined;
}

/** Conflit « supprimé / modifié » ou suppression contre restauration : champ `deleted_at`. */
export const isDeletionColumn = (column: Pick<SyncColumn, 'name'>): boolean => column.name === 'deleted_at';

/** État voulu par la valeur écartée d'un conflit de suppression : supprimé (vrai), présent (faux) ; null si la valeur est invalide. */
export function wantsDeleted(column: SyncColumn, discarded: SyncValue): boolean | null {
  if (discarded === null || discarded === MODIFIED_MARKER) return false;
  return isValidValue(column, discarded) ? true : null;
}

export interface RestoreInput {
  readonly column: SyncColumn;
  readonly discarded: SyncValue;
  /** État de la ligne visée et valeur actuelle du champ. */
  readonly row: ConflictRowState;
  readonly current: SyncValue;
  /** État du parent désigné par la valeur écartée (colonne de clé étrangère), null s'il n'y en a pas. */
  readonly parent: ConflictRowState | null;
}

/**
 * Ce que fait « Restaurer » : refus si la ligne n'existe plus (purgée ou absente), si la valeur écartée ne respecte pas le catalogue
 * ou si le parent qu'elle désigne n'est pas vivant (corbeille comprise) ; rien si la valeur est déjà en place ; sinon écriture, ou
 * suppression / restauration de l'élément pour un conflit de suppression.
 */
export function decideRestore(input: RestoreInput): RestoreDecision {
  if (input.row === 'purged' || input.row === 'missing') return { kind: 'refused', reason: 'row-gone' };
  if (isDeletionColumn(input.column)) {
    const wanted = wantsDeleted(input.column, input.discarded);
    if (wanted === null) return { kind: 'refused', reason: 'invalid' };
    if ((input.current !== null) === wanted) return { kind: 'already' };
    return { kind: 'element', deleted: wanted };
  }
  if (!isValidValue(input.column, input.discarded)) return { kind: 'refused', reason: 'invalid' };
  if (input.parent !== null && input.parent !== 'live') return { kind: 'refused', reason: 'parent-gone' };
  if (sameValue(input.current, input.discarded)) return { kind: 'already' };
  return { kind: 'write' };
}

/** Colonnes dont dépend l'échéance des rappels d'un élément (N-02 critère 5) : à recalculer après une restauration. */
const SCHEDULE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  task: ['date', 'time'],
  routine: ['time', 'schedule_type', 'weekdays', 'times_per_week', 'interval', 'start_date'],
  event: ['start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'repeat', 'kind'],
};

export function affectsReminders(table: Pick<SyncTable, 'name'>, column: Pick<SyncColumn, 'name'>): boolean {
  return (SCHEDULE_COLUMNS[table.name] ?? []).includes(column.name);
}
