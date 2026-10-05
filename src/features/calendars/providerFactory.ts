import type { CalendarProvider } from '../../domain/calendarProvider';
import type { CalendarAccount, CalendarProviderKind } from '../../domain/model';
import type { CalendarAccountId } from '../../domain/types';
import type { CalendarPlatform, TokenRef } from '../../platform/calendars';
import { createCaldavProvider } from './providers/caldav';
import { createGoogleProvider } from './providers/google';

/** Référence du coffre d'un compte (ADR 0008) : `circletasks.calendar.<fournisseur>.<uuid>`, deux espaces de noms (Rust impose le format et refuse à la WebView d'écrire un jeton Google) ; propre à l'appareil, jamais synchronisée avec le secret qu'elle désigne. */
export function tokenRefFor(provider: CalendarProviderKind, accountId: CalendarAccountId): TokenRef {
  return `circletasks.calendar.${provider}.${accountId}`;
}

/**
 * Fournisseur d'un compte : Google (K-01) ou iCloud CalDAV (K-02). L'identifiant Apple de l'authentification Basic est lu dans
 * `username` (colonne locale, ADR 0011 section 8) : un `label` modifié sur un autre appareil ne change jamais l'identifiant envoyé à Apple.
 */
export function createProviderFor(account: Pick<CalendarAccount, 'provider' | 'tokenRef' | 'username'>, platform: CalendarPlatform, nowMs: () => number, timeZone: () => string): CalendarProvider {
  switch (account.provider) {
    case 'google':
      return createGoogleProvider(platform.http, platform.endpoints, account.tokenRef, { nowMs });
    case 'icloud':
      return createCaldavProvider(platform.http, platform.endpoints, account.tokenRef, account.username, { timeZone, nowMs });
  }
}
