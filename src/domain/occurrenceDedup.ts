import { compareCodeUnits } from './compareCodeUnits';
import type { Hlc, RecurrenceId, TaskId } from './types';

/**
 * T-TECH-01 (B8, décision D7) : nettoyage des occurrences dédoublées par les versions d'avant les identifiants déterministes
 * (`occurrenceId.ts`). Deux lignes vivantes de même `(recurrence_id, series_index)` sont un doublon ; une seule est gardée.
 *
 * Le survivant d'un groupe est, dans l'ordre : (1) une ligne terminée (une complétion n'est jamais perdue) ; (2) à égalité, le `hlc` le plus
 * récent (dernière intention de l'utilisateur) ; (3) à égalité, l'identifiant le plus petit (ordre des unités de code : le même sur tous les
 * appareils). Fonction de colonnes répliquées seulement, donc identique sur deux appareils qui ont les mêmes données.
 */
export interface OccurrenceRow {
  readonly id: TaskId;
  readonly recurrenceId: RecurrenceId;
  readonly seriesIndex: number;
  readonly done: boolean;
  readonly hlc: Hlc;
}

/** Clé d'un groupe : une occurrence de série. */
export const groupKey = (recurrenceId: RecurrenceId, seriesIndex: number): string => `${recurrenceId}|${String(seriesIndex)}`;

/** Ordre D7 : terminée d'abord, hlc le plus récent, identifiant le plus petit. */
const byRank = (a: OccurrenceRow, b: OccurrenceRow): number => Number(b.done) - Number(a.done) || compareCodeUnits(b.hlc, a.hlc) || compareCodeUnits(a.id, b.id);

export interface DuplicateGroup {
  readonly recurrenceId: RecurrenceId;
  readonly seriesIndex: number;
  readonly survivor: TaskId;
  /** Lignes écartées (à mettre à la corbeille), dans l'ordre des identifiants. */
  readonly discarded: readonly TaskId[];
}

/**
 * Groupes de doublons parmi des lignes VIVANTES. Les lignes sans récurrence, sans index ou au marqueur d'annulation (`series_index < 0`)
 * ne sont jamais des doublons ; un groupe d'une seule ligne n'en est pas un.
 */
export function duplicateGroups(rows: readonly OccurrenceRow[]): DuplicateGroup[] {
  const byKey = new Map<string, OccurrenceRow[]>();
  for (const row of rows) {
    if (row.seriesIndex < 0) continue;
    const key = groupKey(row.recurrenceId, row.seriesIndex);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const [survivor, ...others] = [...members].sort(byRank);
    if (!survivor) continue;
    groups.push({
      recurrenceId: survivor.recurrenceId,
      seriesIndex: survivor.seriesIndex,
      survivor: survivor.id,
      discarded: others.map((r) => r.id).sort(compareCodeUnits),
    });
  }
  return groups.sort((a, b) => compareCodeUnits(a.survivor, b.survivor));
}

/** Ligne d'un groupe suivi, vivante ou à la corbeille. */
export interface GroupRow extends OccurrenceRow {
  readonly live: boolean;
}

export interface Reconciliation {
  /** Ligne à rétablir (null : aucune). */
  readonly restore: TaskId | null;
  /** Lignes vivantes à écarter. */
  readonly discard: readonly TaskId[];
}

/**
 * Rétablissement après un nettoyage dont les deux appareils n'avaient pas les mêmes données (T-TECH-01 B2), sur les lignes d'un groupe
 * déjà nettoyé : (1) aucune ligne vivante : la ligne que D7 désigne revient ; (2) une vivante, aucune terminée, mais une terminée à la
 * corbeille (complétion arrivée après coup) : la terminée revient, les vivantes sont écartées. Les deux appareils, sur les mêmes lignes,
 * font la même écriture. Autrement : rien (le hlc d'une ligne écartée est celui de son écart, il ne sert pas à défaire un nettoyage).
 */
export function reconcileGroup(rows: readonly GroupRow[]): Reconciliation {
  const live = rows.filter((r) => r.live);
  if (live.length === 0) return { restore: [...rows].sort(byRank)[0]?.id ?? null, discard: [] };
  if (live.some((r) => r.done)) return { restore: null, discard: [] };
  const done = rows.filter((r) => r.done).sort(byRank)[0];
  return done ? { restore: done.id, discard: live.map((r) => r.id).sort(compareCodeUnits) } : { restore: null, discard: [] };
}
