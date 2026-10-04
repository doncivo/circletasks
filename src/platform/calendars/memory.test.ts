import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER, startCalendarSims } from '../../../tests/sim';
import { createMemoryCalendarPlatform } from './memory';
import { CalendarPlatformError, simulatorEndpoints, type CalendarHttpRequest, type CalendarPlatform } from './types';

/** Transport et OAuth en mémoire contre les simulateurs (K-01, K-02) : même contrat que les commandes Rust. */
let sims: Awaited<ReturnType<typeof startCalendarSims>>;
let nowSeconds = 1_800_000_000;
let platform: CalendarPlatform & { readonly memoryVault: { read(ref: string): string | null } };

beforeEach(async () => {
  sims = await startCalendarSims();
  nowSeconds = 1_800_000_000;
  platform = createMemoryCalendarPlatform(simulatorEndpoints(sims.google.baseUrl, sims.caldav.baseUrl), { googleClientId: sims.google.clientId, nowSeconds: () => nowSeconds });
});

afterEach(async () => {
  await sims.close();
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof CalendarPlatformError ? error.code : 'other';
  }
};

const calendarList = (): CalendarHttpRequest => ({ method: 'GET', url: `${sims.google.baseUrl}/calendar/v3/users/me/calendarList`, headers: {}, body: null, auth: { kind: 'google-oauth', tokenRef: 'ref-google' } });

describe('OAuth Google en mémoire', () => {
  it('range les jetons au coffre (PKCE vérifié par le simulateur) sans jamais les rendre', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    expect(await platform.vault.has('ref-google')).toBe(true);
    const stored = JSON.parse(platform.memoryVault.read('ref-google') ?? '{}') as { refresh: string; access: string; expires_at: number };
    expect(stored.refresh).toMatch(/^sim-refresh-/);
    expect(stored.expires_at).toBeGreaterThan(nowSeconds);
    expect('get' in platform.vault).toBe(false);
  });

  it('un refus de consentement annule sans rien enregistrer (K-01 critère 2)', async () => {
    sims.google.denyNextConsent();
    expect(await codeOf(platform.oauth.authorizeGoogle('ref-google'))).toBe('cancelled');
    expect(await platform.vault.has('ref-google')).toBe(false);
  });

  it('sans ID client : config-missing', async () => {
    const bare = createMemoryCalendarPlatform(simulatorEndpoints(sims.google.baseUrl, sims.caldav.baseUrl));
    expect(await codeOf(bare.oauth.authorizeGoogle('ref'))).toBe('config-missing');
  });

  it('simulateur injoignable : network', async () => {
    await sims.close();
    expect(await codeOf(platform.oauth.authorizeGoogle('ref-google'))).toBe('network');
    sims = await startCalendarSims();
  });

  it('révocation : le simulateur oublie le jeton, le coffre est vidé, même si Google est injoignable', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    await platform.oauth.revokeGoogle('ref-google');
    expect(await platform.vault.has('ref-google')).toBe(false);
    expect(sims.google.log.some((line) => line === 'POST /revoke')).toBe(true);
    await platform.vault.set('ref-x', 'pas du json');
    await platform.oauth.revokeGoogle('ref-x');
    expect(await platform.vault.has('ref-x')).toBe(false);
  });
});

describe('transport HTTP en mémoire', () => {
  it('Google : ajoute le jeton du coffre ; sans secret : secret-missing', async () => {
    expect(await codeOf(platform.http.request(calendarList()))).toBe('secret-missing');
    await platform.oauth.authorizeGoogle('ref-google');
    const response = await platform.http.request(calendarList());
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ items: expect.any(Array) as unknown });
  });

  it('Google : jeton expiré, rafraîchi avant l’appel puis rangé ; échéance mesurée avec l’horloge injectée', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    const before = platform.memoryVault.read('ref-google');
    nowSeconds += 4000;
    sims.google.expireAccessTokens();
    expect((await platform.http.request(calendarList())).status).toBe(200);
    expect(sims.google.log.filter((line) => line === 'POST /token')).toHaveLength(2);
    expect(platform.memoryVault.read('ref-google')).not.toBe(before);
  });

  it('Google : 401 avec un jeton en apparence valide : un rafraîchissement, une nouvelle tentative', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    sims.google.expireAccessTokens();
    expect((await platform.http.request(calendarList())).status).toBe(200);
    expect(sims.google.log.filter((line) => line === 'POST /token')).toHaveLength(2);
  });

  it('Google : jeton révoqué : reauth-required, sans boucle', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    sims.google.revokeAll();
    expect(await codeOf(platform.http.request(calendarList()))).toBe('reauth-required');
    expect(sims.google.log.filter((line) => line === 'POST /token')).toHaveLength(2);
  });

  it('iCloud : Basic avec identifiant et mot de passe du coffre', async () => {
    const request: CalendarHttpRequest = { method: 'PROPFIND', url: `${sims.caldav.baseUrl}/`, headers: { Depth: '0' }, body: '<propfind/>', auth: { kind: 'basic', tokenRef: 'ref-icloud', username: CALDAV_USER } };
    expect(await codeOf(platform.http.request(request))).toBe('secret-missing');
    await platform.vault.set('ref-icloud', CALDAV_APP_PASSWORD);
    expect((await platform.http.request(request)).status).toBe(207);
    await platform.vault.set('ref-icloud', 'mauvais');
    expect((await platform.http.request(request)).status).toBe(401);
  });

  it('refuse un hôte hors liste, un en-tête Authorization fourni, une méthode inconnue', async () => {
    const base = calendarList();
    expect(await codeOf(platform.http.request({ ...base, url: 'https://evil.example/x' }))).toBe('host-not-allowed');
    expect(await codeOf(platform.http.request({ ...base, url: 'pas une url' }))).toBe('host-not-allowed');
    expect(await codeOf(platform.http.request({ ...base, headers: { Authorization: 'Bearer volé' } }))).toBe('unsupported');
    expect(await codeOf(platform.http.request({ ...base, method: 'DELETE' as never }))).toBe('unsupported');
  });

  it('une erreur HTTP est une réponse avec ses en-têtes (Retry-After)', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    sims.google.failNext({ status: 429, retryAfterSeconds: 30, pathPrefix: '/calendar' });
    const response = await platform.http.request(calendarList());
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
  });
});

describe('durcissement miroir de Rust', () => {
  it('la WebView ne peut pas écrire une référence Google ; le flux OAuth le peut', async () => {
    await expect(platform.vault.set('circletasks.calendar.google.0f8fad5b-d9cb-469f-a165-70867728950e', 'faux')).rejects.toMatchObject({ code: 'vault-unavailable' });
    await platform.vault.set('circletasks.calendar.icloud.0f8fad5b-d9cb-469f-a165-70867728950e', 'pw');
    await platform.oauth.authorizeGoogle('circletasks.calendar.google.0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(await platform.vault.has('circletasks.calendar.google.0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
  });

  it('seuls les en-têtes de la liste blanche passent', async () => {
    await platform.oauth.authorizeGoogle('ref-google');
    for (const name of ['Cookie', 'X-Autre', 'Host']) expect(await codeOf(platform.http.request({ ...calendarList(), headers: { [name]: 'x' } }))).toBe('unsupported');
    expect((await platform.http.request({ ...calendarList(), headers: { Accept: 'application/json' } })).status).toBe(200);
  });
});
