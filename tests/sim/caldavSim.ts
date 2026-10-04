import { startSim, type RunningSim, type SimRequest, type SimResponse } from './httpSim';
import { CALDAV_FIXTURE_CALENDARS, type CaldavSimCalendar } from './caldavFixtures';

/**
 * Simulateur CalDAV iCloud (K-02, K-03, ADR 0008) : Basic (identifiant Apple + mot de passe d'application), découverte
 * (`/.well-known/caldav`, `current-user-principal`, `calendar-home-set`), liste des collections (nom, couleur, composants, ctag),
 * `REPORT calendar-query` avec plage (les objets de fixtures sont DÉJÀ développés comme le fait iCloud avec `expand`), erreurs
 * injectées (401, 403, 404, 5xx via `failNext`).
 */

export const CALDAV_USER = 'ali.test@icloud.com';
export const CALDAV_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const PRINCIPAL = '/1234567/principal/';
const HOME = '/1234567/calendars/';

export interface CaldavSimOptions {
  readonly calendars?: readonly CaldavSimCalendar[];
  readonly username?: string;
  readonly password?: string;
  readonly port?: number;
}

export interface CaldavSim extends RunningSim {
  /** Change le mot de passe accepté (révocation : 401 au rafraîchissement, K-02 critère 6). */
  setPassword(password: string): void;
  /** Remplace les objets d'une collection et incrémente son ctag (K-03 critère 3). */
  setObjects(calendarId: string, objects: CaldavSimCalendar['objects']): void;
}

const xml = (status: number, body: string): SimResponse => ({ status, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}` });

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

/** « 20260801T000000Z » → millisecondes. */
const parseIcalUtc = (value: string): number =>
  Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)));

export async function startCaldavSim(options: CaldavSimOptions = {}): Promise<CaldavSim> {
  const username = options.username ?? CALDAV_USER;
  let password = options.password ?? CALDAV_APP_PASSWORD;
  const calendars = (options.calendars ?? CALDAV_FIXTURE_CALENDARS).map((calendar) => ({ ...calendar, ctag: 1 }));

  const authorized = (request: SimRequest): boolean => request.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const collection = (calendar: (typeof calendars)[number]): string => `
  <d:response><d:href>${HOME}${calendar.id}/</d:href><d:propstat><d:prop>
    <d:displayname>${escapeXml(calendar.name)}</d:displayname>
    <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
    <ic:calendar-color>${calendar.color}</ic:calendar-color>
    <cs:getctag>sim-ctag-${calendar.ctag}</cs:getctag>
    <c:supported-calendar-component-set><c:comp name="${calendar.component}"/></c:supported-calendar-component-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  const handler = (request: SimRequest): SimResponse => {
    const { pathname } = request.url;
    if (pathname === '/.well-known/caldav') return { status: 301, headers: { location: '/' } };
    if (!authorized(request)) return { status: 401, headers: { 'www-authenticate': 'Basic realm="iCloud"' } };
    if (request.method === 'PROPFIND' && pathname === '/') {
      return xml(207, `<d:multistatus ${NS}><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }
    if (request.method === 'PROPFIND' && pathname === PRINCIPAL) {
      return xml(207, `<d:multistatus ${NS}><d:response><d:href>${PRINCIPAL}</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }
    if (request.method === 'PROPFIND' && pathname === HOME) {
      return xml(207, `<d:multistatus ${NS}>${calendars.map(collection).join('')}</d:multistatus>`);
    }
    const target = calendars.find((calendar) => pathname === `${HOME}${calendar.id}/`);
    if (!target) return { status: 404 };
    if (request.method === 'PROPFIND') return xml(207, `<d:multistatus ${NS}>${collection(target)}</d:multistatus>`);
    if (request.method === 'REPORT') {
      const range = /time-range[^>]*start="(\d{8}T\d{6}Z)"[^>]*end="(\d{8}T\d{6}Z)"/.exec(request.body);
      const start = range?.[1] ? parseIcalUtc(range[1]) : Number.NEGATIVE_INFINITY;
      const end = range?.[2] ? parseIcalUtc(range[2]) : Number.POSITIVE_INFINITY;
      const objects = target.objects.filter((object) => Date.parse(object.startUtc) < end && Date.parse(object.endUtc) > start);
      const responses = objects
        .map(
          (object) => `
  <d:response><d:href>${HOME}${target.id}/${object.href}</d:href><d:propstat><d:prop>
    <d:getetag>"${object.etag}"</d:getetag><c:calendar-data>${escapeXml(object.ics)}</c:calendar-data>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        )
        .join('');
      return xml(207, `<d:multistatus ${NS}>${responses}</d:multistatus>`);
    }
    return { status: 405 };
  };

  const running = await startSim(handler, options.port);
  return {
    ...running,
    setPassword: (next) => void (password = next),
    setObjects: (calendarId, objects) => {
      const calendar = calendars.find((candidate) => candidate.id === calendarId);
      if (!calendar) throw new Error(`Agenda simulé inconnu : ${calendarId}`);
      calendar.objects = objects;
      calendar.ctag += 1;
    },
  };
}
