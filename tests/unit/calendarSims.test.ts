import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER, GOOGLE_SCOPE, startCalendarSims } from '../sim';

/** Contrôle des simulateurs d'agendas (ADR 0008) : ils doivent se comporter comme Google et iCloud pour les tests de K-01 à K-03. */
let sims: Awaited<ReturnType<typeof startCalendarSims>>;

beforeAll(async () => {
  sims = await startCalendarSims();
});

afterAll(async () => {
  await sims.close();
});

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('simulateur Google', () => {
  it('autorise avec PKCE, liste les agendas, puis refuse après révocation', async () => {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'http://127.0.0.1:53682/';
    const auth = new URL(`${sims.google.baseUrl}/o/oauth2/v2/auth`);
    for (const [key, value] of Object.entries({ client_id: sims.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPE, state: 's1', code_challenge: challenge, code_challenge_method: 'S256' })) {
      auth.searchParams.set(key, value);
    }
    const consent = await fetch(auth, { redirect: 'manual' });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get('location') ?? '');
    expect(back.searchParams.get('state')).toBe('s1');

    const token = await fetch(`${sims.google.baseUrl}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '', code_verifier: verifier, redirect_uri: redirectUri, client_id: sims.google.clientId }),
    });
    const { access_token: accessToken } = (await token.json()) as { access_token: string };
    const list = await fetch(`${sims.google.baseUrl}/calendar/v3/users/me/calendarList`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(2);

    sims.google.revokeAll();
    const refused = await fetch(`${sims.google.baseUrl}/calendar/v3/users/me/calendarList`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(refused.status).toBe(401);
  });

  it('sert une erreur injectée avec Retry-After', async () => {
    sims.google.failNext({ status: 429, retryAfterSeconds: 30, pathPrefix: '/calendar' });
    const response = await fetch(`${sims.google.baseUrl}/calendar/v3/users/me/calendarList`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });
});

describe('simulateur CalDAV', () => {
  it('découvre le principal et ne renvoie que les objets de la plage', async () => {
    const authorization = basic(CALDAV_USER, CALDAV_APP_PASSWORD);
    const principal = await fetch(`${sims.caldav.baseUrl}/`, { method: 'PROPFIND', headers: { authorization, depth: '0' } });
    expect(principal.status).toBe(207);
    expect(await principal.text()).toContain('/1234567/principal/');

    const body = '<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20260924T000000Z" end="20260925T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    const report = await fetch(`${sims.caldav.baseUrl}/1234567/calendars/famille/`, { method: 'REPORT', headers: { authorization, depth: '1' }, body });
    const text = await report.text();
    expect(text).toContain('UID:diner-1');
    expect(text).not.toContain('UID:weekend-1');
  });

  it('refuse un mauvais mot de passe d’application', async () => {
    const response = await fetch(`${sims.caldav.baseUrl}/`, { method: 'PROPFIND', headers: { authorization: basic(CALDAV_USER, 'faux') } });
    expect(response.status).toBe(401);
  });
});
