import type { CalendarEvent, ChecklistSummary } from '../../domain/model';
import type { LocalDate, SpaceFilter } from '../../domain/types';
import type { DateRange } from './common';

/**
 * Lectures minimales posées à l'ordre 1 pour Aujourd'hui et Semaine (A-01, S-01).
 * Écritures, modèles et jours fériés : checklists-events, ordre 2 (contrat étendu
 * par ajout de méthodes, sans casser celles-ci).
 */
export interface EventRepository {
  /**
   * Événements dont une occurrence peut tomber dans la plage : ceux qui la
   * chevauchent, plus ceux répétés (monthly, yearly). Le calcul exact des
   * occurrences est fait par src/domain.
   */
  listCandidatesForRange(range: DateRange, filter: SpaceFilter): Promise<CalendarEvent[]>;
}

export interface ChecklistRepository {
  /** C-03 : checklists associées à un jour, avec progression « 3/5 ». */
  listSummariesForDay(date: LocalDate, filter: SpaceFilter): Promise<ChecklistSummary[]>;
  listSummariesForRange(range: DateRange, filter: SpaceFilter): Promise<ChecklistSummary[]>;
}
