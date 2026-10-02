import type { CalendarAccount, CalendarEvent, ChecklistSummary, ExternalEvent } from '../../domain/model';
import type { LocalDate, SpaceFilter } from '../../domain/types';
import type { DateRange, InstantRange } from './common';

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

/**
 * Événements des agendas externes (M8) : lecture seule à l'ordre 1 (S-05) ; les écritures de rafraîchissement (K-01 à K-03,
 * ordre 2) s'ajouteront à ce contrat sans casser cette méthode. Aucune ligne n'existe tant qu'aucun agenda n'est connecté.
 */
export interface ExternalEventRepository {
  /**
   * Événements qui chevauchent la plage d'instants UTC (début avant `to`, fin après `from` ; sans fin : début à `from` ou après ; les fins sont exclues),
   * triés par début. Une journée entière stocke sa date civile en UTC : l'appelant élargit la plage de ±1 jour pour la couvrir ;
   * le calcul exact par jour local est fait par src/domain.
   */
  listBetween(range: InstantRange): Promise<ExternalEvent[]>;
}

/** Comptes d'agenda externes (M8) : lecture seule à l'ordre 1 (S-05, rattachement des agendas à un espace). */
export interface CalendarAccountRepository {
  /** Comptes non supprimés, avec leurs agendas (rattachement à un espace, affiché ou non), triés par libellé. */
  listAll(): Promise<CalendarAccount[]>;
}
