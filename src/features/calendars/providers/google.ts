import type { CalendarProvider, FetchRange, ProviderCalendar, ProviderEvent } from '../../../domain/calendarProvider';
import { toStoredInstant } from '../../../domain/calendarProvider';
import type { CalendarEndpoints, CalendarHttp, TokenRef } from '../../../platform/calendars';
import { callProvider, parseJson } from './transport';

/**
 * Fournisseur Google Agenda (K-01, K-03, ADR 0008), lecture seule : `calendarList` et `events.list` avec `singleEvents=true` (Google
 * développe les séries en instances). La WebView ne voit aucun jeton : le transport (Rust) ajoute `Authorization`. Une seule portée
 * existe (`calendar.readonly`) et aucune méthode d'écriture : seuls des GET sont émis.
 */

interface GoogleOptions {
  readonly nowMs?: () => number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Google signale un quota dépassé par un 403 : raison `rateLimitExceeded`, `userRateLimitExceeded` ou `quotaExceeded`. */
function isQuotaBody(body: string): boolean {
  const parsed = parseJson(body);
  const errors = isObject(parsed) && isObject(parsed['error']) ? parsed['error']['errors'] : undefined;
  return Array.isArray(errors) && errors.some((entry) => isObject(entry) && typeof entry['reason'] === 'string' && /ratelimitexceeded|quotaexceeded/i.test(entry['reason']));
}

/** `{ dateTime }` → instant UTC ; `{ date }` → date civile (journée entière). null : ni l'un ni l'autre, ou illisible. */
function pointOf(value: unknown): { readonly instant: string; readonly allDay: boolean } | null {
  if (!isObject(value)) return null;
  const date = text(value['date']);
  if (date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) return { instant: date, allDay: true };
  const dateTime = text(value['dateTime']);
  if (dateTime === null) return null;
  const ms = Date.parse(dateTime);
  return Number.isNaN(ms) ? null : { instant: toStoredInstant(ms), allDay: false };
}

export function parseGoogleEvent(calendarId: string, raw: unknown): ProviderEvent | null {
  if (!isObject(raw) || raw['status'] === 'cancelled') return null;
  const externalId = text(raw['id']);
  const start = pointOf(raw['start']);
  if (externalId === null || start === null) return null;
  const end = pointOf(raw['end']);
  return {
    calendarId,
    externalId,
    title: text(raw['summary']) ?? '',
    startUtc: start.instant,
    endUtc: end !== null && end.allDay === start.allDay ? end.instant : null,
    allDay: start.allDay,
  };
}

export function createGoogleProvider(http: CalendarHttp, endpoints: CalendarEndpoints, tokenRef: TokenRef, options: GoogleOptions = {}): CalendarProvider {
  const auth = { kind: 'google-oauth', tokenRef } as const;
  const call = (url: URL) => callProvider(http, { method: 'GET', url: url.toString(), headers: {}, body: null, auth }, { ...(options.nowMs ? { nowMs: options.nowMs } : {}), rateLimited403: isQuotaBody });
  return {
    kind: 'google',
    async listCalendars() {
      const calendars: ProviderCalendar[] = [];
      let pageToken: string | null = null;
      do {
        const url = new URL(`${endpoints.googleApiBase}/users/me/calendarList`);
        url.searchParams.set('minAccessRole', 'reader');
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        const response = await call(url);
        if (!response.ok) return response;
        const body = parseJson(response.value.body);
        if (!isObject(body) || !Array.isArray(body['items'])) return { ok: false, error: { kind: 'malformed' } };
        for (const item of body['items'] as unknown[]) {
          if (!isObject(item)) continue;
          const id = text(item['id']);
          if (id === null) continue;
          const color = text(item['backgroundColor']);
          calendars.push({
            id,
            name: text(item['summaryOverride']) ?? text(item['summary']) ?? id,
            color: color !== null && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
            primary: item['primary'] === true,
          });
        }
        pageToken = text(body['nextPageToken']);
      } while (pageToken !== null);
      return { ok: true, value: calendars };
    },

    async fetchEvents(calendarId, range: FetchRange) {
      const events: ProviderEvent[] = [];
      let pageToken: string | null = null;
      do {
        const url = new URL(`${endpoints.googleApiBase}/calendars/${encodeURIComponent(calendarId)}/events`);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set('showDeleted', 'false');
        url.searchParams.set('maxResults', '250');
        url.searchParams.set('timeMin', range.fromUtc);
        url.searchParams.set('timeMax', range.toUtc);
        if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
        const response = await call(url);
        if (!response.ok) return response;
        const body = parseJson(response.value.body);
        if (!isObject(body) || !Array.isArray(body['items'])) return { ok: false, error: { kind: 'malformed' } };
        for (const item of body['items'] as unknown[]) {
          const event = parseGoogleEvent(calendarId, item);
          if (event) events.push(event);
        }
        pageToken = text(body['nextPageToken']);
      } while (pageToken !== null);
      // Google n'a pas de curseur ici (K-03 D1) : la fenêtre est relue en entier à chaque fois.
      return { ok: true, value: { kind: 'full', events, cursor: null } };
    },
  };
}
