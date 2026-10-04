import { invoke } from '@tauri-apps/api/core';
import { CalendarPlatformError, PRODUCTION_ENDPOINTS, type CalendarHttpRequest, type CalendarHttpResponse, type CalendarPlatform, type CalendarPlatformErrorCode, type TokenRef } from './types';

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

const CODES: readonly CalendarPlatformErrorCode[] = ['host-not-allowed', 'secret-missing', 'reauth-required', 'cancelled', 'state-mismatch', 'config-missing', 'network', 'timeout', 'vault-unavailable', 'unsupported'];

/** Rejet Rust (code en chaîne, sans secret) → `CalendarPlatformError` ; un rejet inattendu devient `unsupported`, jamais son texte. */
export function toPlatformError(rejection: unknown): CalendarPlatformError {
  const code = CODES.find((candidate) => candidate === rejection);
  return new CalendarPlatformError(code ?? 'unsupported');
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (rejection) {
    throw toPlatformError(rejection);
  }
}

export function createTauriCalendarPlatform(): CalendarPlatform {
  return {
    endpoints: PRODUCTION_ENDPOINTS,
    vault: {
      set: (tokenRef: TokenRef, secret: string) => call<null>(CALENDAR_COMMANDS.secretSet, { tokenRef, secret }).then(() => undefined),
      has: (tokenRef: TokenRef) => call<boolean>(CALENDAR_COMMANDS.secretExists, { tokenRef }),
      delete: (tokenRef: TokenRef) => call<null>(CALENDAR_COMMANDS.secretDelete, { tokenRef }).then(() => undefined),
    },
    http: {
      request: (request: CalendarHttpRequest) => call<CalendarHttpResponse>(CALENDAR_COMMANDS.http, { request }),
    },
    oauth: {
      authorizeGoogle: (tokenRef: TokenRef) => call<null>(CALENDAR_COMMANDS.oauthGoogleAuthorize, { tokenRef }).then(() => undefined),
      revokeGoogle: (tokenRef: TokenRef) => call<null>(CALENDAR_COMMANDS.oauthGoogleRevoke, { tokenRef }).then(() => undefined),
    },
  };
}
