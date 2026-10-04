import type { FocusSession, FocusSessionPatch, NewFocusSession } from '../../domain/model';
import type { FocusSessionId } from '../../domain/types';

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
}
