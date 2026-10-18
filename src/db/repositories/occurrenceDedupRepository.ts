import type { OccurrenceRow } from '../../domain/occurrenceDedup';

/**
 * T-TECH-01 : lecture des occurrences de série vivantes qui ont au moins une jumelle vivante (même `recurrence_id` et même `series_index`
 * positif). Aucune règle métier : le survivant est choisi par `src/domain/occurrenceDedup.ts`, les écarts écrits par `TaskRepository` et
 * `ReminderRepository` (suppression logique, hlc de l'appareil). Implémentation chargée **à la demande** (`sql/occurrenceDedup.ts`).
 */
export interface OccurrenceDedupRepository {
  listLiveDuplicates(): Promise<OccurrenceRow[]>;
}

// Exposé par `Repositories.occurrenceDedup` (bloc « T-TECH-01 » de `sql/index.ts`) : fabrique à la demande, liée à l'exécuteur.
declare module './dataAccess' {
  interface Repositories {
    /** Doublons d'occurrences de série (T-TECH-01), chargés à la demande. */
    readonly occurrenceDedup: () => Promise<OccurrenceDedupRepository>;
  }
}
