import { invoke } from '@tauri-apps/api/core';
import { PRODUCTION_ENDPOINTS, type CalendarHttpRequest, type CalendarHttpResponse, type CalendarPlatform, type TokenRef } from './types';

/**
 * Commandes Rust des agendas (src-tauri/src/calendars, ADR 0008), mêmes noms sur PC et iPhone. Les rejets portent le code de
 * `CalendarPlatformErrorCode` dans une chaîne ; la conversion en `CalendarPlatformError` est à écrire par calendar-integration.
 */
export const CALENDAR_COMMANDS = {
  secretSet: 'calendar_secret_set',
  secretExists: 'calendar_secret_exists',
  secretDelete: 'calendar_secret_delete',
  oauthGoogleAuthorize: 'calendar_oauth_google_authorize',
  oauthGoogleRevoke: 'calendar_oauth_google_revoke',
  http: 'calendar_http',
} as const;

export function createTauriCalendarPlatform(): CalendarPlatform {
  return {
    endpoints: PRODUCTION_ENDPOINTS,
    vault: {
      set: (tokenRef: TokenRef, secret: string) => invoke<null>(CALENDAR_COMMANDS.secretSet, { tokenRef, secret }).then(() => undefined),
      has: (tokenRef: TokenRef) => invoke<boolean>(CALENDAR_COMMANDS.secretExists, { tokenRef }),
      delete: (tokenRef: TokenRef) => invoke<null>(CALENDAR_COMMANDS.secretDelete, { tokenRef }).then(() => undefined),
    },
    http: {
      request: (request: CalendarHttpRequest) => invoke<CalendarHttpResponse>(CALENDAR_COMMANDS.http, { request }),
    },
    oauth: {
      authorizeGoogle: (tokenRef: TokenRef) => invoke<null>(CALENDAR_COMMANDS.oauthGoogleAuthorize, { tokenRef }).then(() => undefined),
      revokeGoogle: (tokenRef: TokenRef) => invoke<null>(CALENDAR_COMMANDS.oauthGoogleRevoke, { tokenRef }).then(() => undefined),
    },
  };
}
