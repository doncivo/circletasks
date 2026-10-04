import type { ActiveStatuses } from './appStatus';
import type { ProviderError } from './calendarProvider';
import type { CalendarAccount } from './model';
import type { CalendarAccountId, IsoDateTime } from './types';

/**
 * Rafraîchissement des agendas externes et état des comptes (K-03, A-09 critère 10, ADR 0008). Règles pures : l'horloge, le
 * premier plan et le verrou par compte sont fournis par l'appelant (planificateur de src/features/calendars).
 *
 * L'état d'un compte est LOCAL à l'appareil (jamais en base ni dans les journaux de synchro) : il dépend du coffre de l'appareil
 * (K-01 D1) et du dernier résultat réseau ; il est recalculé au démarrage (secret absent → « à reconnecter »).
 */

/** K-03 : échéance de 15 min, comptée depuis la dernière réussite, au premier plan seulement (K-03 D3). */
export const CALENDAR_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export type RefreshTrigger =
  /** Ouverture de l'app (critère 1) : toujours. */
  | 'open'
  /** Retour au premier plan : seulement si la dernière réussite date de plus de 15 min (critère 1). */
  | 'resume'
  /** Échéance du minuteur au premier plan (critère 2). */
  | 'tick'
  /** Bouton « Actualiser » (critère 8) ; ignoré si un rafraîchissement du compte est en cours (critère 7). */
  | 'manual'
  /** Juste après connexion ou changement des agendas affichés (K-01 critère 6). */
  | 'connected';

export type CalendarAccountState =
  | { readonly kind: 'connected'; readonly lastSuccessAt: IsoDateTime | null }
  /** A-09 : « Agenda <label> déconnecté » + « Reconnecter » ; aucune nouvelle tentative automatique (K-03 critère 6). */
  | { readonly kind: 'reconnect-required'; readonly lastSuccessAt: IsoDateTime | null }
  /** Réseau ou serveur : données conservées, « Hors ligne » (K-03 critère 5) ; `retryAt` respecte un 429. */
  | {
      readonly kind: 'error';
      readonly lastSuccessAt: IsoDateTime | null;
      readonly error: 'network' | 'server' | 'rate-limited';
      readonly retryAt: IsoDateTime | null;
    };

export interface RefreshDecisionInput {
  readonly state: CalendarAccountState;
  readonly trigger: RefreshTrigger;
  readonly now: IsoDateTime;
  readonly foreground: boolean;
  /** Un rafraîchissement de ce compte est déjà en cours (verrou par compte, critère 7). */
  readonly inFlight: boolean;
}

/** Faut-il rafraîchir ce compte maintenant ? À implémenter (K-03, domain-logic) avec horloge simulée. */
export function shouldRefresh(_input: RefreshDecisionInput): boolean {
  throw new Error('K-03 : shouldRefresh à implémenter');
}

export type RefreshOutcome = { readonly ok: true; readonly at: IsoDateTime } | { readonly ok: false; readonly at: IsoDateTime; readonly error: ProviderError };

/**
 * Nouvel état après une tentative : réussite → connecté ; `unauthorized` → à reconnecter ; `rate-limited` → erreur avec `retryAt` ;
 * `network` / `server` → erreur ; `forbidden` / `not-found` / `malformed` ne concernent qu'un agenda (compte inchangé).
 * À implémenter (K-03).
 */
export function nextAccountState(_previous: CalendarAccountState, _outcome: RefreshOutcome): CalendarAccountState {
  throw new Error('K-03 : nextAccountState à implémenter');
}

/**
 * États A-09 émis par les agendas : `calendarDisconnected` (detail = label du premier compte à reconnecter), `offline` si un compte
 * est en erreur réseau. À implémenter (K-01 critère 7, A-09 critère 10).
 */
export function calendarAppStatuses(
  _accounts: readonly Pick<CalendarAccount, 'id' | 'label'>[],
  _states: ReadonlyMap<CalendarAccountId, CalendarAccountState>,
): ActiveStatuses {
  throw new Error('A-09 : calendarAppStatuses à implémenter');
}
