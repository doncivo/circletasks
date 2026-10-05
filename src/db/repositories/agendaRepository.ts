import type { CalendarAccount, CalendarEvent, CalendarProviderKind, CalendarRef, EventPatch, ExternalEvent, NewEvent } from '../../domain/model';
import type { CalendarAccountId, EventId, ExternalEventId, SpaceFilter } from '../../domain/types';
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
 * Événements des agendas externes (M8) : lecture (S-05) et écritures de rafraîchissement (K-01 à K-03). La table est locale, sans
 * colonnes de synchro (ADR 0004 avenant S-05) : chaque appareil relit ses agendas. L'identifiant de ligne est déterministe
 * (`externalEventRowId`) : un upsert le conserve, le lien d'une tâche (K-04) survit aux rafraîchissements.
 */
export interface ExternalEventRepository {
  /**
   * Événements qui chevauchent la plage d'instants UTC (début avant `to`, fin après `from` ; sans fin : début à `from` ou après ; les fins sont exclues),
   * triés par début. Une journée entière stocke sa date civile en UTC : l'appelant élargit la plage de ±1 jour pour la couvrir ;
   * le calcul exact par jour local est fait par src/domain.
   */
  listBetween(range: InstantRange): Promise<ExternalEvent[]>;
  /** K-04 : une ligne par identifiant ; null si elle a disparu (rafraîchissement, compte supprimé). */
  getById(id: ExternalEventId): Promise<ExternalEvent | null>;
  /**
   * K-03 critère 3 : remplace la fenêtre d'un agenda. Les lignes de `events` sont insérées ou mises à jour (même identifiant), celles
   * de l'agenda qui recoupent `range` et ne sont plus dans `events` sont supprimées. À appeler dans une transaction.
   */
  replaceWindow(accountId: CalendarAccountId, calendarId: string, events: readonly ExternalEvent[], range: InstantRange): Promise<void>;
  /** Agenda masqué (K-03 critère 4) : retire toutes ses lignes. */
  deleteForCalendar(accountId: CalendarAccountId, calendarId: string): Promise<void>;
  /** Compte supprimé (K-01 critère 8) : retire toutes ses lignes. */
  deleteForAccount(accountId: CalendarAccountId): Promise<void>;
}

/** Nouveau compte d'agenda (K-01, K-02) : `tokenRef` seul, jamais un secret. */
export interface NewCalendarAccount {
  readonly id: CalendarAccountId;
  readonly provider: CalendarProviderKind;
  readonly label: string;
  readonly tokenRef: string;
  /** Identifiant Apple (iCloud) ; colonne locale, jamais publiée. Vide par défaut. */
  readonly username?: string;
  readonly calendars: readonly CalendarRef[];
}

/** Comptes d'agenda externes (M8) : lecture (S-05, rattachement des agendas à un espace) et écritures de K-01 / K-02. */
export interface CalendarAccountRepository {
  /** Comptes non supprimés, avec leurs agendas (rattachement à un espace, affiché ou non), triés par libellé. */
  listAll(): Promise<CalendarAccount[]>;
  getById(id: CalendarAccountId): Promise<CalendarAccount | null>;
  create(account: NewCalendarAccount): Promise<CalendarAccount>;
  /** Agendas affichés et leur espace (ES-06) ; remplace la liste entière. */
  updateCalendars(id: CalendarAccountId, calendars: readonly CalendarRef[]): Promise<CalendarAccount>;
  /** Suppression logique (K-01 critère 8) : le compte disparaît de la liste, ses lignes d'événements sont retirées à part. */
  softDelete(id: CalendarAccountId): Promise<CalendarAccount>;
  /**
   * Y-02 (ADR 0011 section 8) : complète un compte reçu par la synchro (identifiant Apple et référence du coffre, colonnes locales) ;
   * aucun tampon d'écriture : rien n'est publié.
   */
  setLocalCredentials(id: CalendarAccountId, credentials: { readonly username: string; readonly tokenRef: string }): Promise<CalendarAccount>;
}
