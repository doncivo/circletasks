import { createHash, randomUUID } from 'node:crypto';
import { json, startSim, type RunningSim, type SimRequest, type SimResponse } from './httpSim';

/**
 * Simulateur Google (K-01, K-03, ADR 0008) : autorisation OAuth avec PKCE S256 et `state`, jeton, rafraîchissement, révocation,
 * `calendarList`, `events.list` (instances développées, journées entières, annulés, pagination) et erreurs injectées.
 * Mêmes chemins que Google sur une seule origine :
 *   GET  /o/oauth2/v2/auth           (accounts.google.com)
 *   POST /token, POST /revoke        (oauth2.googleapis.com)
 *   GET  /calendar/v3/...            (www.googleapis.com)
 * Usage : `const sim = await startGoogleSim()` dans un test Vitest ou un `globalSetup` Playwright ; `await sim.close()`.
 */

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface GoogleSimCalendar {
  readonly id: string;
  readonly summary: string;
  readonly backgroundColor: string;
  readonly primary?: boolean;
}

/** Événement au format `events.list` (instance déjà développée si `recurringEventId`). */
export interface GoogleSimEvent {
  readonly calendarId: string;
  readonly id: string;
  readonly status: 'confirmed' | 'cancelled';
  readonly summary?: string;
  readonly start: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly end: { readonly dateTime?: string; readonly date?: string; readonly timeZone?: string };
  readonly recurringEventId?: string;
}

export const GOOGLE_ACCOUNT = 'ali.test@example.com';

export const DEFAULT_GOOGLE_CALENDARS: readonly GoogleSimCalendar[] = [
  { id: GOOGLE_ACCOUNT, summary: 'Travail', backgroundColor: '#3F6FB5', primary: true },
  { id: 'famille@group.calendar.google.com', summary: 'Famille', backgroundColor: '#B5483B' },
];

export const DEFAULT_GOOGLE_EVENTS: readonly GoogleSimEvent[] = [
  { calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client', start: { dateTime: '2026-09-23T10:00:00+02:00', timeZone: 'Europe/Paris' }, end: { dateTime: '2026-09-23T11:00:00+02:00' } },
  { calendarId: GOOGLE_ACCOUNT, id: 'standup_20260921T070000Z', recurringEventId: 'standup', status: 'confirmed', summary: 'Stand-up', start: { dateTime: '2026-09-21T07:00:00Z' }, end: { dateTime: '2026-09-21T07:15:00Z' } },
  { calendarId: GOOGLE_ACCOUNT, id: 'standup_20260922T070000Z', recurringEventId: 'standup', status: 'cancelled', start: { dateTime: '2026-09-22T07:00:00Z' }, end: { dateTime: '2026-09-22T07:15:00Z' } },
  { calendarId: 'famille@group.calendar.google.com', id: 'vacances', status: 'confirmed', summary: 'Vacances', start: { date: '2026-10-19' }, end: { date: '2026-10-24' } },
  { calendarId: 'famille@group.calendar.google.com', id: 'sans-titre', status: 'confirmed', start: { date: '2026-09-25' }, end: { date: '2026-09-26' } },
];

export interface GoogleSimOptions {
  readonly calendars?: readonly GoogleSimCalendar[];
  readonly events?: readonly GoogleSimEvent[];
  readonly clientId?: string;
  /** Taille de page de `events.list` (pagination testée avec une petite valeur). */
  readonly pageSize?: number;
  readonly port?: number;
}

export interface GoogleSim extends RunningSim {
  readonly clientId: string;
  /** Le prochain consentement est refusé (`error=access_denied`, K-01 critère 2). */
  denyNextConsent(): void;
  /** Révoque tous les jetons : 401 puis `invalid_grant` au rafraîchissement (K-01 critère 7). */
  revokeAll(): void;
  /** Les jetons d'accès en cours expirent (le rafraîchissement doit suivre). */
  expireAccessTokens(): void;
  /** Remplace les événements (ajout, déplacement, suppression côté serveur, K-03 critère 3). */
  setEvents(events: readonly GoogleSimEvent[]): void;
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

export async function startGoogleSim(options: GoogleSimOptions = {}): Promise<GoogleSim> {
  const clientId = options.clientId ?? 'sim-client.apps.googleusercontent.com';
  const pageSize = options.pageSize ?? 250;
  const calendars = options.calendars ?? DEFAULT_GOOGLE_CALENDARS;
  let events = options.events ?? DEFAULT_GOOGLE_EVENTS;
  let denyConsent = false;
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  const issueAccess = (): string => {
    const token = `sim-access-${randomUUID()}`;
    accessTokens.add(token);
    return token;
  };

  const authorized = (request: SimRequest): boolean => {
    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') && accessTokens.has(header.slice('Bearer '.length));
  };

  const unauthorized = (): SimResponse => json(401, { error: { code: 401, message: 'Invalid Credentials' } });

  const handler = (request: SimRequest): SimResponse => {
    const { pathname, searchParams } = request.url;
    if (request.method === 'GET' && pathname === '/o/oauth2/v2/auth') {
      const redirectUri = searchParams.get('redirect_uri') ?? '';
      const state = searchParams.get('state') ?? '';
      const target = new URL(redirectUri);
      if (searchParams.get('client_id') !== clientId || searchParams.get('scope') !== GOOGLE_SCOPE || searchParams.get('code_challenge_method') !== 'S256') {
        return json(400, { error: 'invalid_request' });
      }
      if (denyConsent) {
        denyConsent = false;
        target.searchParams.set('error', 'access_denied');
      } else {
        const code = `sim-code-${randomUUID()}`;
        codes.set(code, { challenge: searchParams.get('code_challenge') ?? '', redirectUri });
        target.searchParams.set('code', code);
      }
      target.searchParams.set('state', state);
      return { status: 302, headers: { location: target.toString() } };
    }
    if (request.method === 'POST' && pathname === '/token') {
      const form = new URLSearchParams(request.body);
      if (form.get('client_id') !== clientId) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!pending || pending.redirectUri !== form.get('redirect_uri') || base64url(createHash('sha256').update(verifier).digest()) !== pending.challenge) {
          return json(400, { error: 'invalid_grant' });
        }
        const refresh = `sim-refresh-${randomUUID()}`;
        refreshTokens.add(refresh);
        return json(200, { access_token: issueAccess(), expires_in: 3599, refresh_token: refresh, scope: GOOGLE_SCOPE, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!refreshTokens.has(form.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: issueAccess(), expires_in: 3599, scope: GOOGLE_SCOPE, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (request.method === 'POST' && pathname === '/revoke') {
      const token = searchParams.get('token') ?? new URLSearchParams(request.body).get('token') ?? '';
      refreshTokens.delete(token);
      accessTokens.delete(token);
      return json(200, {});
    }
    if (request.method === 'GET' && pathname === '/calendar/v3/users/me/calendarList') {
      if (!authorized(request)) return unauthorized();
      return json(200, { kind: 'calendar#calendarList', items: calendars.map((calendar) => ({ ...calendar, accessRole: 'owner' })) });
    }
    const eventsPath = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(pathname);
    if (request.method === 'GET' && eventsPath?.[1] !== undefined) {
      if (!authorized(request)) return unauthorized();
      const calendarId = decodeURIComponent(eventsPath[1]);
      if (!calendars.some((calendar) => calendar.id === calendarId)) return json(404, { error: { code: 404, message: 'Not Found' } });
      if (searchParams.get('singleEvents') !== 'true') return json(400, { error: { code: 400, message: 'singleEvents=true attendu' } });
      const timeMin = searchParams.get('timeMin') ?? '';
      const timeMax = searchParams.get('timeMax') ?? '';
      const instant = (point: GoogleSimEvent['start']): number => Date.parse(point.dateTime ?? `${point.date ?? ''}T00:00:00Z`);
      const inRange = events.filter(
        (event) => event.calendarId === calendarId && (timeMax === '' || instant(event.start) < Date.parse(timeMax)) && (timeMin === '' || instant(event.end) > Date.parse(timeMin)),
      );
      const offset = Number(searchParams.get('pageToken') ?? '0');
      const page = inRange.slice(offset, offset + pageSize).map(({ calendarId: _calendarId, ...event }) => event);
      const next = offset + pageSize < inRange.length ? { nextPageToken: String(offset + pageSize) } : {};
      return json(200, { kind: 'calendar#events', items: page, ...next });
    }
    return json(404, { error: { code: 404, message: 'Not Found' } });
  };

  const running = await startSim(handler, options.port);
  return {
    ...running,
    clientId,
    denyNextConsent: () => void (denyConsent = true),
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    expireAccessTokens: () => accessTokens.clear(),
    setEvents: (next) => void (events = next),
  };
}
