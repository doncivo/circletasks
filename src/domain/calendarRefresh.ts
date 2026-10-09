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
      readonly error: 'network' | 'server' | 'rate-limited' | 'unavailable';
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

/**
 * Faut-il rafraîchir ce compte maintenant ? (K-03 critères 1, 2, 5, 6, 7, D3)
 * - un rafraîchissement du compte est en cours : jamais, manuel compris (critère 7) ;
 * - « à reconnecter » : aucune tentative automatique (critère 6) ; « Actualiser » et la reconnexion réessaient ;
 * - 429 : le délai du serveur est respecté pour tous les déclencheurs ; autre erreur : la prochaine échéance (`retryAt`) est
 *   attendue par l'échéance du minuteur et le retour au premier plan ;
 * - ouverture, connexion, « Actualiser » : toujours ; retour au premier plan et échéance : au premier plan seulement, 15 min après la
 *   dernière réussite (D3).
 */
export function shouldRefresh(input: RefreshDecisionInput): boolean {
  const { state, trigger, now, foreground, inFlight } = input;
  if (inFlight) return false;
  if (state.kind === 'reconnect-required') return trigger === 'manual' || trigger === 'connected';
  const nowMs = Date.parse(now);
  if (state.kind === 'error' && state.retryAt !== null && nowMs < Date.parse(state.retryAt)) {
    if (state.error === 'rate-limited' || trigger === 'tick' || trigger === 'resume') return false;
  }
  if (trigger === 'open' || trigger === 'manual' || trigger === 'connected') return true;
  if (!foreground) return false;
  if (state.lastSuccessAt === null) return true;
  return nowMs - Date.parse(state.lastSuccessAt) >= CALENDAR_REFRESH_INTERVAL_MS;
}

export type RefreshOutcome = { readonly ok: true; readonly at: IsoDateTime } | { readonly ok: false; readonly at: IsoDateTime; readonly error: ProviderError };

/**
 * Nouvel état après une tentative : réussite → connecté ; `unauthorized` → à reconnecter ; `rate-limited` → erreur avec `retryAt`
 * (délai du serveur, sinon 15 min) ; `network` / `server` → erreur, prochaine tentative 15 min plus tard ; `forbidden` /
 * `not-found` / `malformed` ne concernent qu'un agenda (compte inchangé).
 */
export function nextAccountState(previous: CalendarAccountState, outcome: RefreshOutcome): CalendarAccountState {
  if (outcome.ok) return { kind: 'connected', lastSuccessAt: outcome.at };
  const { error, at } = outcome;
  const lastSuccessAt = previous.lastSuccessAt;
  const after = (ms: number): IsoDateTime => new Date(Date.parse(at) + ms).toISOString() as IsoDateTime;
  switch (error.kind) {
    case 'unauthorized':
      return { kind: 'reconnect-required', lastSuccessAt };
    case 'rate-limited':
      return { kind: 'error', lastSuccessAt, error: 'rate-limited', retryAt: after(error.retryAfterMs ?? CALENDAR_REFRESH_INTERVAL_MS) };
    case 'network':
      return { kind: 'error', lastSuccessAt, error: 'network', retryAt: after(CALENDAR_REFRESH_INTERVAL_MS) };
    case 'server':
      return { kind: 'error', lastSuccessAt, error: 'server', retryAt: after(CALENDAR_REFRESH_INTERVAL_MS) };
    case 'unavailable':
      return { kind: 'error', lastSuccessAt, error: 'unavailable', retryAt: after(CALENDAR_REFRESH_INTERVAL_MS) };
    case 'forbidden':
    case 'not-found':
    case 'malformed':
      return previous;
  }
}

/** Premier compte à reconnecter, dans l'ordre donné : celui que désigne le bandeau « Agenda … déconnecté » (et son action). */
export function disconnectedAccount<A extends Pick<CalendarAccount, 'id'>>(accounts: readonly A[], states: ReadonlyMap<CalendarAccountId, CalendarAccountState>): A | undefined {
  return accounts.find((account) => states.get(account.id)?.kind === 'reconnect-required');
}

/**
 * États A-09 émis par les agendas : `calendarDisconnected` (detail = label du premier compte à reconnecter, dans l'ordre donné),
 * `offline` si un compte est en erreur réseau ou serveur (K-03 critère 5). Un compte sans état (pas encore tenté) n'émet rien.
 */
export function calendarAppStatuses(accounts: readonly Pick<CalendarAccount, 'id' | 'label'>[], states: ReadonlyMap<CalendarAccountId, CalendarAccountState>): ActiveStatuses {
  const disconnected = disconnectedAccount(accounts, states);
  const offline = accounts.some((account) => {
    const state = states.get(account.id);
    return state?.kind === 'error' && (state.error === 'network' || state.error === 'server');
  });
  return { ...(disconnected ? { calendarDisconnected: { detail: disconnected.label } } : {}), ...(offline ? { offline: {} } : {}) };
}
