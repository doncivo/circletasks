import type { CalendarAccount, CalendarEvent, EventPatch, ExternalEvent, NewEvent } from '../../domain/model';
import type { EventId, SpaceFilter } from '../../domain/types';
import type { DateRange, InstantRange, ReadOptions } from './common';

/**
 * Événements locaux (M7). Lecture posée à l'ordre 1 pour Aujourd'hui et Semaine (A-01, S-01) ; écritures de E-01 (création,
 * modification de toute la série, suppression logique et restauration pour « Annuler »). Aucune règle métier ici (titre, plage,
 * occurrences) : `src/domain/eventRules.ts` et `eventOccurrences.ts`. Les jours fériés ont leur propre contrat (holidayRepository.ts, E-03).
 */
export interface EventRepository {
  /**
   * Événements dont une occurrence peut tomber dans la plage : ceux qui la
   * chevauchent, plus ceux répétés (monthly, yearly). Le calcul exact des
   * occurrences est fait par src/domain.
   */
  listCandidatesForRange(range: DateRange, filter: SpaceFilter): Promise<CalendarEvent[]>;
  getById(id: EventId, options?: ReadOptions): Promise<CalendarEvent | null>;
  /** E-01 : crée un événement (champs déjà validés par le domaine). */
  create(event: NewEvent): Promise<CalendarEvent>;
  /** E-01 critère 7 : une modification s'applique à toute la série. */
  update(id: EventId, patch: EventPatch): Promise<CalendarEvent>;
  /** E-01 critère 7 : suppression logique (annulable 5 s). */
  softDelete(id: EventId): Promise<CalendarEvent>;
  restore(id: EventId): Promise<CalendarEvent>;
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
