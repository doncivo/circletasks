import type { CalendarProvider } from '../../domain/calendarProvider';
import type { CalendarAccount } from '../../domain/model';
import type { CalendarAccountId } from '../../domain/types';
import type { CalendarPlatform, TokenRef } from '../../platform/calendars';
import { createGoogleProvider } from './providers/google';

/** Référence du coffre d'un compte (ADR 0008) : propre à l'appareil, jamais synchronisée avec le secret qu'elle désigne. */
export function tokenRefFor(accountId: CalendarAccountId): TokenRef {
  return `circletasks.calendar.${accountId}`;
}

/** Fournisseur d'un compte : Google (K-01) ou iCloud CalDAV (K-02). Le label d'un compte iCloud est l'identifiant Apple. */
export function createProviderFor(account: Pick<CalendarAccount, 'provider' | 'tokenRef' | 'label'>, platform: CalendarPlatform, nowMs: () => number): CalendarProvider {
  switch (account.provider) {
    case 'google':
      return createGoogleProvider(platform.http, platform.endpoints, account.tokenRef, { nowMs });
    case 'icloud':
      throw new Error('K-02 : fournisseur iCloud à brancher');
  }
}
