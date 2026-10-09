import type { CalendarProvider, ProviderError } from '../../domain/calendarProvider';
import type { CalendarAccount, CalendarProviderKind } from '../../domain/model';
import type { CalendarAccountId, Result } from '../../domain/types';
import type { CalendarPlatform, TokenRef } from '../../platform/calendars';
import { logFailure } from '../../platform/desktop/log';

/** Référence du coffre d'un compte (ADR 0008) : `circletasks.calendar.<fournisseur>.<uuid>`, deux espaces de noms (Rust impose le format et refuse à la WebView d'écrire un jeton Google) ; propre à l'appareil, jamais synchronisée avec le secret qu'elle désigne. */
export function tokenRefFor(provider: CalendarProviderKind, accountId: CalendarAccountId): TokenRef {
  return `circletasks.calendar.${provider}.${accountId}`;
}

/**
 * Fournisseur d'un compte : Google (K-01) ou iCloud CalDAV (K-02). L'identifiant Apple de l'authentification Basic est lu dans
 * `username` (colonne locale, ADR 0011 section 8) : un `label` modifié sur un autre appareil ne change jamais l'identifiant envoyé à Apple.
 */
export function createProviderFor(account: Pick<CalendarAccount, 'provider' | 'tokenRef' | 'username'>, platform: CalendarPlatform, nowMs: () => number, timeZone: () => string): CalendarProvider {
  // Les fournisseurs (Google, CalDAV, iCalendar) sont chargés à la première lecture : hors du bundle de départ (budget de 350 Ko gzip).
  const real = async (): Promise<CalendarProvider> => {
    switch (account.provider) {
      case 'google':
        return (await import('./providers/google')).createGoogleProvider(platform.http, platform.endpoints, account.tokenRef, { nowMs });
      case 'icloud':
        return (await import('./providers/caldav')).createCaldavProvider(platform.http, platform.endpoints, account.tokenRef, account.username, { timeZone, nowMs });
    }
  };
  // Un chargement impossible est un échec visible (état « Indisponible » du compte, nouvel essai au passage suivant), jamais un silence ni « réseau » ; le
  // journal reçoit un code fixe (jamais le message de l'erreur, qui peut nommer une URL).
  const failed = (): Result<never, ProviderError> => {
    logFailure('calendars', 'provider-load-failed');
    return { ok: false, error: { kind: 'unavailable' } };
  };
  const load = async (): Promise<CalendarProvider | Result<never, ProviderError>> => {
    try {
      return await real();
    } catch {
      return failed();
    }
  };
  const isProvider = (value: CalendarProvider | Result<never, ProviderError>): value is CalendarProvider => 'listCalendars' in value;
  return {
    kind: account.provider,
    listCalendars: async () => {
      const loaded = await load();
      return isProvider(loaded) ? loaded.listCalendars() : loaded;
    },
    fetchEvents: async (calendarId, range, cursor) => {
      const loaded = await load();
      return isProvider(loaded) ? loaded.fetchEvents(calendarId, range, cursor) : loaded;
    },
  };
}
