import type { CalendarProvider, FetchRange, ProviderCalendar, ProviderError, ProviderEvent } from '../../../domain/calendarProvider';
import type { Result } from '../../../domain/types';
import type { CalendarEndpoints, CalendarHttp, CalendarHttpResponse, TokenRef } from '../../../platform/calendars';
import { eventsFromIcs, isReadableIcs } from './icsEvents';
import { callProvider } from './transport';
import { findNode, findNodes, parseXml, textOf, type XmlNode } from './xml';

/**
 * Fournisseur iCloud CalDAV (K-02, K-03, ADR 0008), lecture seule : découverte depuis `caldav.icloud.com` (`current-user-principal` puis
 * `calendar-home-set`, hôte `pNN-caldav` attribué par Apple), collections `VEVENT` seules (les listes Rappels sont ignorées, K-05),
 * `REPORT calendar-query` avec plage et `expand`, ctag par collection pour sauter les agendas inchangés (K-03 D1). Authentification
 * Basic par Rust à partir du coffre : identifiant Apple + mot de passe d'application ; la WebView n'envoie que `tokenRef`. Seuls
 * `PROPFIND` et `REPORT` sont émis : aucune écriture.
 */

interface CaldavOptions {
  /** Fuseau de l'appareil : heures flottantes (K-02 critère 5). */
  readonly timeZone: () => string;
  readonly nowMs?: () => number;
}

const NAMESPACES = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${NAMESPACES}><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const HOME_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${NAMESPACES}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const COLLECTIONS_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${NAMESPACES}><d:prop><d:displayname/><d:resourcetype/><ic:calendar-color/><cs:getctag/><c:supported-calendar-component-set/></d:prop></d:propfind>`;
const CTAG_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind ${NAMESPACES}><d:prop><cs:getctag/></d:prop></d:propfind>`;

/** « 20260801T000000Z » : format des plages CalDAV. */
const compactUtc = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

function reportBody(range: FetchRange): string {
  const start = compactUtc(range.fromUtc);
  const end = compactUtc(range.toUtc);
  return `<?xml version="1.0" encoding="UTF-8"?><c:calendar-query ${NAMESPACES}><d:prop><d:getetag/><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** `#RRGGBBAA` (Apple) → `#RRGGBB` ; null si la couleur n'est pas lisible. */
function normalizeColor(value: string | null): string | null {
  const match = value ? /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim()) : null;
  return match ? `#${(match[1] ?? '').toUpperCase()}` : null;
}

/** Réponses `response` d'un 207 dont le `propstat` est un succès (200) : [href, nœud `prop`]. */
function okResponses(root: XmlNode): { href: string; prop: XmlNode }[] {
  const result: { href: string; prop: XmlNode }[] = [];
  for (const response of findNodes(root, 'response')) {
    const href = textOf(response, 'href');
    if (!href) continue;
    for (const propstat of findNodes(response, 'propstat')) {
      const status = textOf(propstat, 'status') ?? '';
      const prop = findNode(propstat, 'prop');
      if (prop && /\s2\d\d(\s|$)/.test(status)) result.push({ href, prop });
    }
  }
  return result;
}

export function createCaldavProvider(http: CalendarHttp, endpoints: CalendarEndpoints, tokenRef: TokenRef, username: string, options: CaldavOptions): CalendarProvider {
  const auth = { kind: 'basic', tokenRef, username } as const;
  const base = endpoints.caldavBase.replace(/\/$/, '');
  let homeUrl: Promise<Result<URL, ProviderError>> | null = null;

  const call = (method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string) =>
    callProvider(http, { method, url, headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body, auth }, { okStatuses: [207], ...(options.nowMs ? { nowMs: options.nowMs } : {}) });

  const multistatus = (response: CalendarHttpResponse): XmlNode | null => {
    const root = parseXml(response.body);
    return root?.name === 'multistatus' ? root : null;
  };

  async function discover(): Promise<Result<URL, ProviderError>> {
    // 1. Point d'entrée : /.well-known/caldav (redirigé par le serveur), repli sur la racine du serveur.
    let principalHref: string | null = null;
    for (const entry of [`${base}/.well-known/caldav`, `${base}/`]) {
      const response = await call('PROPFIND', entry, '0', PRINCIPAL_BODY);
      if (!response.ok) {
        if (response.error.kind === 'not-found') continue;
        return response;
      }
      const root = multistatus(response.value);
      const principal = root ? findNode(root, 'current-user-principal') : null;
      principalHref = principal ? textOf(principal, 'href') : null;
      if (principalHref) break;
    }
    if (!principalHref) return { ok: false, error: { kind: 'malformed' } };
    // 2. Le principal annonce le dossier des agendas, sur le serveur `pNN-caldav` de l'utilisateur.
    const principalUrl = new URL(principalHref, `${base}/`);
    const home = await call('PROPFIND', principalUrl.toString(), '0', HOME_BODY);
    if (!home.ok) return home;
    const homeRoot = multistatus(home.value);
    const homeSet = homeRoot ? findNode(homeRoot, 'calendar-home-set') : null;
    const homeHref = homeSet ? textOf(homeSet, 'href') : null;
    if (!homeHref) return { ok: false, error: { kind: 'malformed' } };
    return { ok: true, value: new URL(homeHref, principalUrl) };
  }

  const home = (): Promise<Result<URL, ProviderError>> => {
    homeUrl ??= discover().then((result) => {
      // Un échec n'est pas mémorisé : la tentative suivante redécouvre.
      if (!result.ok) homeUrl = null;
      return result;
    });
    return homeUrl;
  };

  async function ctagOf(collection: URL): Promise<Result<string | null, ProviderError>> {
    const response = await call('PROPFIND', collection.toString(), '0', CTAG_BODY);
    if (!response.ok) return response;
    const root = multistatus(response.value);
    if (!root) return { ok: false, error: { kind: 'malformed' } };
    const found = okResponses(root).map(({ prop }) => textOf(prop, 'getctag')).find((value): value is string => value !== null && value !== '');
    return { ok: true, value: found ?? null };
  }

  return {
    kind: 'icloud',

    async listCalendars() {
      const homeResult = await home();
      if (!homeResult.ok) return homeResult;
      const response = await call('PROPFIND', homeResult.value.toString(), '1', COLLECTIONS_BODY);
      if (!response.ok) return response;
      const root = multistatus(response.value);
      if (!root) return { ok: false, error: { kind: 'malformed' } };
      const calendars: ProviderCalendar[] = [];
      for (const { href, prop } of okResponses(root)) {
        const resourceType = findNode(prop, 'resourcetype');
        // Seules les collections d'agendas : ni la racine, ni les boîtes de planification, ni les notifications.
        if (!resourceType || !findNode(resourceType, 'calendar')) continue;
        const components = findNodes(prop, 'comp').map((comp) => (comp.attributes['name'] ?? '').toUpperCase());
        if (components.length > 0 && !components.includes('VEVENT')) continue;
        const path = new URL(href, homeResult.value).pathname;
        const name = textOf(prop, 'displayname');
        calendars.push({ id: path, name: name && name !== '' ? name : decodeURIComponent(path.split('/').filter(Boolean).pop() ?? path), color: normalizeColor(textOf(prop, 'calendar-color')), primary: false });
      }
      return { ok: true, value: calendars };
    },

    async fetchEvents(calendarId, range, cursor) {
      const homeResult = await home();
      if (!homeResult.ok) return homeResult;
      const collection = new URL(calendarId, homeResult.value);
      const windowKey = `${range.fromUtc.slice(0, 10)}..${range.toUtc.slice(0, 10)}`;
      const ctag = await ctagOf(collection);
      if (!ctag.ok) return ctag;
      const nextCursor = ctag.value === null ? null : `${ctag.value}|${windowKey}`;
      // Rien n'a changé depuis la dernière lecture de cette fenêtre : aucune requête de plus.
      if (nextCursor !== null && cursor === nextCursor) return { ok: true, value: { kind: 'unchanged', cursor } };
      const response = await call('REPORT', collection.toString(), '1', reportBody(range));
      if (!response.ok) return response;
      const root = multistatus(response.value);
      if (!root) return { ok: false, error: { kind: 'malformed' } };
      const window = { fromMs: Date.parse(range.fromUtc), toMs: Date.parse(range.toUtc) };
      const events: ProviderEvent[] = [];
      const objects = okResponses(root).flatMap(({ prop }) => {
        const data = textOf(prop, 'calendar-data');
        return data ? [data] : [];
      });
      // Tous les objets illisibles : réponse inutilisable, pas un agenda vide (l'ancien état est conservé). Un objet illisible parmi
      // d'autres lisibles est simplement ignoré.
      if (objects.length > 0 && !objects.some(isReadableIcs)) return { ok: false, error: { kind: 'malformed' } };
      for (const data of objects) events.push(...eventsFromIcs(calendarId, data, window, options.timeZone()));
      return { ok: true, value: { kind: 'full', events, cursor: nextCursor } };
    },
  };
}
