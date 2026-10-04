import type { FocusTaskTotal, FocusTotal, InstantSpan } from '../../domain/focusTotals';
import type { ItemFilter } from '../../domain/itemFilter';
import type { FocusSession, FocusSessionPatch, NewFocusSession } from '../../domain/model';
import type { FocusSessionId, TaskId } from '../../domain/types';

/** Plage d'instants (début de session) et filtre d'espace / projet (ES-08) des totaux de concentration. */
export interface FocusTotalsQuery {
  readonly span: InstantSpan;
  readonly filter: ItemFilter;
}

/**
 * Sessions de concentration (M10, F-01 à F-04). Aucune règle métier ici (durées, pauses, terme, plafond de 8 h) : elles vivent dans
 * `src/domain/focusSession.ts` et sont appliquées par les cas d'usage de `src/features/focus`.
 */
export interface FocusSessionRepository {
  getById(id: FocusSessionId): Promise<FocusSession | null>;
  /**
   * La session ouverte (`ended_at` nul, non supprimée) ; null s'il n'y en a pas. Une seule est permise par les cas d'usage ; si deux
   * appareils hors ligne en ont ouvert une chacun, la plus récente est rendue.
   */
  getOpen(): Promise<FocusSession | null>;
  /** Enregistre la session dès le lancement (F-01 critère 5) : `ended_at` vide, `paused_sec` 0. */
  create(input: NewFocusSession): Promise<FocusSession>;
  /** Durée prévue, fin, pauses ; `RepositoryError('not-found')` si la session n'existe pas ou est supprimée. */
  update(id: FocusSessionId, patch: FocusSessionPatch): Promise<FocusSession>;
  /** F-01 critère 7 : session de moins d'une minute, supprimée sans trace (suppression logique, exclue de tous les totaux). */
  discard(id: FocusSessionId): Promise<void>;

  /**
   * F-03 : total des sessions TERMINÉES dont le début tombe dans la plage (agrégat SQL, 2 000 lignes en moins de 50 ms). Espace : celui de
   * la session ; projet : celui de sa tâche (ES-08), une session sans tâche n'est comptée que sous « Tous les projets ». Les sessions
   * supprimées (moins d'une minute) n'existent pas ; celles d'une tâche supprimée restent comptées.
   */
  totals(query: FocusTotalsQuery): Promise<FocusTotal>;
  /** F-03 : les tâches les plus travaillées de la plage, du plus au moins travaillé (sessions sans tâche ignorées). */
  totalsByTask(query: FocusTotalsQuery, limit: number): Promise<FocusTaskTotal[]>;
  /**
   * H-03 : une page de sessions (supprimées exclues) du filtre d'espace / projet, par identifiant croissant après `afterId` ; `span`
   * limite aux sessions dont le début tombe dans la plage (null : toutes). Lecture par blocs de `limit` lignes.
   */
  listForExport(query: { readonly filter: ItemFilter; readonly span: InstantSpan | null; readonly afterId: string | null; readonly limit: number }): Promise<FocusSession[]>;
  /** F-03 critère 3 : temps de concentration de toutes les sessions terminées de cette tâche, sans filtre. */
  totalsForTask(taskId: TaskId): Promise<FocusTotal>;
}
