import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { InstantRange } from '../../db/repositories';
import type { CalendarAccountId } from '../../domain/types';
import { useAppStatusStore } from '../app/appStatus';
import { useNavigationStore } from '../app/navigation';
import { calendarsStore, type CalendarsState } from './calendarsStore';
import { dumpDatabaseText, setupCalendarHarness, type CalendarHarness } from './testKit';

const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;

let h: CalendarHarness;
const store = () => calendarsStore.get(h.container);
const state = (): CalendarsState => store().getState();

async function idle(): Promise<void> {
  await vi.waitFor(() => expect(state().refreshing).toEqual([]));
}

async function connected(): Promise<CalendarAccountId> {
  const outcome = await state().connectGoogle();
  if (!outcome.ok) throw new Error(`connexion refusée : ${outcome.failure}`);
  await vi.waitFor(() => expect(state().states[outcome.accountId]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await idle();
  return outcome.accountId;
}

const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((event) => event.title).sort();

beforeEach(async () => {
  h = await setupCalendarHarness('1');
});
afterEach(() => h.close());

describe('connexion Google (K-01)', () => {
  it('crée le compte (adresse = label), range les jetons au coffre, charge les agendas en Pro et les événements', async () => {
    const accountId = await connected();
    const [account] = await h.container.data.repos.calendarAccounts.listAll();
    expect(account).toMatchObject({ id: accountId, provider: 'google', label: GOOGLE_ACCOUNT, tokenRef: `circletasks.calendar.google.${accountId}` });
    expect(account?.calendars).toEqual([
      { id: GOOGLE_ACCOUNT, name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
      { id: 'famille@group.calendar.google.com', name: 'Famille', spaceId: SPACE_PRO_ID, shown: true },
    ]);
    expect(await h.container.calendars.vault.has(account?.tokenRef ?? '')).toBe(true);
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
  });

  it('aucun jeton ni identifiant client dans la base, l’état de l’interface ni les messages', async () => {
    await connected();
    const secret = h.vault.read(`circletasks.calendar.google.${state().accounts[0]?.id ?? ''}`) ?? '';
    expect(secret).toContain('sim-refresh-');
    const dump = await dumpDatabaseText(h.db);
    for (const fragment of ['sim-refresh-', 'sim-access-', h.google.clientId]) {
      expect(dump).not.toContain(fragment);
      expect(JSON.stringify({ ...state(), reconnectRequest: null })).not.toContain(fragment);
    }
  });

  it('refus ou fermeture du consentement : « annulée », rien d’enregistré (critère 2)', async () => {
    h.google.denyNextConsent();
    expect(await state().connectGoogle()).toEqual({ ok: false, failure: 'cancelled' });
    expect(state().accounts).toEqual([]);
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
    expect(h.vault.refs()).toEqual([]);
    expect(state().connecting).toBe(false);
  });

  it('sans ID client : « non configuré », rien d’enregistré', async () => {
    await h.close();
    h = await setupCalendarHarness('2', { noGoogleClient: true });
    expect(await state().connectGoogle()).toEqual({ ok: false, failure: 'not-configured' });
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('un même compte connecté deux fois : refusé, le second jeton est révoqué', async () => {
    await connected();
    expect(await state().connectGoogle()).toEqual({ ok: false, failure: 'duplicate' });
    expect(state().accounts).toHaveLength(1);
    expect(h.google.log.filter((line) => line === 'POST /revoke')).toHaveLength(1);
  });

  it('Google injoignable après le consentement : rien d’enregistré, jeton révoqué', async () => {
    h.google.failNext({ status: 503, pathPrefix: '/calendar' });
    expect(await state().connectGoogle()).toEqual({ ok: false, failure: 'google-unreachable' });
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('une seule connexion à la fois', async () => {
    const first = state().connectGoogle();
    expect(await state().connectGoogle()).toEqual({ ok: false, failure: 'failed' });
    expect((await first).ok).toBe(true);
    await idle();
  });
});

describe('agendas affichés et espaces (K-01 critères 4 et 5, ES-06 critères 5 et 6)', () => {
  it('changer l’espace d’un agenda est enregistré aussitôt, sans nouvelle lecture réseau', async () => {
    const accountId = await connected();
    const before = h.google.log.length;
    const [account] = state().accounts;
    const calendars = (account?.calendars ?? []).map((calendar) => (calendar.name === 'Famille' ? { ...calendar, spaceId: SPACE_PERSO_ID } : calendar));
    expect(await state().setCalendars(accountId, calendars)).toBe('ok');
    expect(state().accounts[0]?.calendars.find((calendar) => calendar.name === 'Famille')?.spaceId).toBe(SPACE_PERSO_ID);
    expect(h.google.log.length).toBe(before);
  });

  it('décocher « Afficher » retire les événements de l’agenda de toutes les vues ; le recocher les relit', async () => {
    const accountId = await connected();
    const calendars = state().accounts[0]?.calendars ?? [];
    const family = calendars.map((calendar) => (calendar.name === 'Famille' ? { ...calendar, shown: false } : calendar));
    expect(await state().setCalendars(accountId, family)).toBe('ok');
    expect(await titles()).toEqual(['Point client', 'Stand-up']);
    expect(await state().setCalendars(accountId, calendars)).toBe('ok');
    await idle();
    await vi.waitFor(async () => expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']));
  });

  it('un agenda affiché sans espace, ou avec un espace inconnu, est refusé', async () => {
    const accountId = await connected();
    const calendars = state().accounts[0]?.calendars ?? [];
    expect(await state().setCalendars(accountId, calendars.map((calendar) => ({ ...calendar, spaceId: null })))).toBe('space-required');
    expect(await state().setCalendars(accountId, calendars.map((calendar) => ({ ...calendar, spaceId: 'inconnu' as never })))).toBe('space-required');
    expect(await state().setCalendars(accountId, calendars.map((calendar) => ({ ...calendar, spaceId: null, shown: false })))).toBe('ok');
  });
});

describe('jeton refusé ou révoqué (K-01 critère 7, A-09 critère 10)', () => {
  it('le compte passe « à reconnecter », les événements restent, le cadre d’état propose « Reconnecter »', async () => {
    const accountId = await connected();
    h.google.revokeAll();
    h.db.clock.advance(60_000);
    expect(await state().refresh(accountId, 'manual')).toBe('done');
    expect(state().states[accountId]).toMatchObject({ kind: 'reconnect-required' });
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
    const banner = useAppStatusStore.getState().sources.calendarDisconnected;
    expect(banner?.detail).toBe(GOOGLE_ACCOUNT);
    // Aucune nouvelle tentative automatique (K-03 critère 6).
    const requests = h.google.log.length;
    h.db.clock.advance(3_600_000);
    expect(await state().refresh(accountId, 'tick')).toBe('skipped');
    expect(await state().refresh(accountId, 'open')).toBe('skipped');
    expect(h.google.log.length).toBe(requests);
  });

  it('« Reconnecter » ouvre l’écran Agendas, relance le flux, rétablit le compte et retire l’alerte', async () => {
    const accountId = await connected();
    h.google.revokeAll();
    await state().refresh(accountId, 'manual');
    useAppStatusStore.getState().sources.calendarDisconnected?.onAction?.();
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'calendars' });
    await vi.waitFor(() => expect(state().states[accountId]).toMatchObject({ kind: 'connected' }));
    await idle();
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeUndefined();
    expect(state().accounts).toHaveLength(1);
  });

  it('un appareil sans secret (compte venu de la synchro) apparaît « à reconnecter » dès le chargement (D1)', async () => {
    await h.container.data.repos.calendarAccounts.create({ id: 'a0000000-0000-4000-8000-000000000001' as CalendarAccountId, provider: 'google', label: 'autre@example.com', tokenRef: 'circletasks.calendar.google.a0000000-0000-4000-8000-000000000009', calendars: [] });
    await state().load();
    expect(state().states['a0000000-0000-4000-8000-000000000001']).toMatchObject({ kind: 'reconnect-required' });
    expect(useAppStatusStore.getState().sources.calendarDisconnected?.detail).toBe('autre@example.com');
  });
});

describe('connexion abandonnée dont le jeton ne s’efface pas (revue PR #25, point 2)', () => {
  it('doublon à la connexion Google : jeton gardé signalé, puis effacé par « Réessayer l’effacement »', async () => {
    await connected();
    const revoke = vi.spyOn(h.container.calendars.oauth, 'revokeGoogle').mockRejectedValue(new Error('coffre indisponible'));
    const outcome = await state().connectGoogle();
    expect(outcome).toEqual({ ok: false, failure: 'duplicate' });
    expect(state().orphanSecrets).toHaveLength(1);
    const orphan = state().orphanSecrets[0];
    expect(orphan?.provider).toBe('google');
    expect(await h.container.calendars.vault.has(orphan?.tokenRef ?? '')).toBe(true);
    revoke.mockRestore();
    await state().retryForgetSecrets();
    expect(state().orphanSecrets).toEqual([]);
    expect(await h.container.calendars.vault.has(orphan?.tokenRef ?? '')).toBe(false);
  });
});

describe('« Connecter ici » : compte Google reçu du PC, jamais connecté sur cet appareil (K-01 D1)', () => {
  const RECEIVED = 'a0000000-0000-4000-8000-0000000000c1' as CalendarAccountId;
  const FRESH_REF = `circletasks.calendar.google.${RECEIVED}`;

  /** Ligne telle que la synchro la crée : colonnes publiées, `token_ref` local vide. */
  async function received(label = GOOGLE_ACCOUNT): Promise<void> {
    await h.container.data.repos.calendarAccounts.create({ id: RECEIVED, provider: 'google', label, tokenRef: '', calendars: [] });
    await state().load();
    expect(state().states[RECEIVED]).toMatchObject({ kind: 'elsewhere' });
  }

  const localRef = async (): Promise<string | undefined> => (await h.container.data.repos.calendarAccounts.getById(RECEIVED))?.tokenRef;

  it('lance la connexion de CET appareil sous une référence neuve (jamais la référence vide), la garde en local, compte connecté', async () => {
    await received();
    const authorize = vi.spyOn(h.container.calendars.oauth, 'authorizeGoogle');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: true, accountId: RECEIVED });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(FRESH_REF);
    expect(authorize).not.toHaveBeenCalledWith('');
    expect(await localRef()).toBe(FRESH_REF);
    expect(await h.container.calendars.vault.has(FRESH_REF)).toBe(true);
    await vi.waitFor(() => expect(state().states[RECEIVED]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
    await idle();
    // Colonne locale seulement : rien n'entre dans la file d'envoi de la synchro.
    expect(await h.db.driver.select("SELECT field FROM sync_outbox WHERE table_name = 'calendar_account' AND field <> '*'")).toEqual([]);
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeUndefined();
  });

  it('« Connecter ici » de la carte passe par la même connexion (requestReconnect)', async () => {
    await received();
    state().requestReconnect(RECEIVED);
    await vi.waitFor(() => expect(state().states[RECEIVED]).toMatchObject({ kind: 'connected' }));
    expect(await localRef()).toBe(FRESH_REF);
    await idle();
  });

  it('annulation : message « Connexion annulée », compte toujours « ailleurs », rien gardé ; un nouvel essai réussit', async () => {
    await received();
    h.google.denyNextConsent();
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'cancelled' });
    expect(state().messageKey).toBe('calendars.errorCancelled');
    expect(state().states[RECEIVED]).toMatchObject({ kind: 'elsewhere' });
    expect(await localRef()).toBe('');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: true, accountId: RECEIVED });
    await vi.waitFor(() => expect(state().states[RECEIVED]).toMatchObject({ kind: 'connected' }));
    await idle();
  });

  it('échec de la feuille iPhone : code et « Réessayer » sur ce compte (googleFailure), puis réussite', async () => {
    await received();
    h.failWebAuth('web-auth-failed');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'web-auth-failed' });
    expect(state().googleFailure).toEqual({ code: 'web-auth-failed', accountId: RECEIVED });
    expect(await localRef()).toBe('');
    h.failWebAuth(null);
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: true, accountId: RECEIVED });
    expect(state().googleFailure).toBeNull();
    await idle();
  });

  it('ligne sans libellé et compte sans agenda (agenda principal introuvable) : refusé (« failed »), rien rattaché, jeton effacé', async () => {
    await h.close();
    h = await setupCalendarHarness('1', { google: { calendars: [] } });
    await received('');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'failed' });
    expect(await localRef()).toBe('');
    expect(await h.container.calendars.vault.has(FRESH_REF)).toBe(false);
    expect(state().states[RECEIVED]).toMatchObject({ kind: 'elsewhere' });
  });

  it('même compte Google déjà connecté ici sur une autre ligne : « duplicate » sans connexion ni jeton', async () => {
    const own = await connected();
    expect(state().accounts.find((account) => account.id === own)?.label).toBe(GOOGLE_ACCOUNT);
    await received();
    const authorize = vi.spyOn(h.container.calendars.oauth, 'authorizeGoogle');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'duplicate' });
    expect(state().messageKey).toBe('calendars.errorDuplicate');
    expect(authorize).not.toHaveBeenCalled();
    expect(await localRef()).toBe('');
    expect(state().connecting).toBe(false);
  });

  it('jeton refusé qui ne s’efface pas : signalé (orphanSecrets), « Réessayer l’effacement » l’efface ensuite', async () => {
    await received('autre@example.com');
    const revoke = vi.spyOn(h.container.calendars.oauth, 'revokeGoogle').mockRejectedValue(new Error('coffre indisponible'));
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'google-other-account' });
    expect(state().orphanSecrets).toEqual([{ provider: 'google', tokenRef: FRESH_REF }]);
    expect(await h.container.calendars.vault.has(FRESH_REF)).toBe(true);
    // Nouvel échec : toujours signalé.
    await state().retryForgetSecrets();
    expect(state().orphanSecrets).toHaveLength(1);
    revoke.mockRestore();
    await state().retryForgetSecrets();
    expect(state().orphanSecrets).toEqual([]);
    expect(await h.container.calendars.vault.has(FRESH_REF)).toBe(false);
  });

  it('autre compte Google que celui de la ligne : jeton révoqué et effacé, rien rattaché, message dédié', async () => {
    await received('autre@example.com');
    expect(await state().reconnectGoogle(RECEIVED)).toEqual({ ok: false, failure: 'google-other-account' });
    expect(state().messageKey).toBe('calendars.errorGoogleOtherAccount');
    expect(await h.container.calendars.vault.has(FRESH_REF)).toBe(false);
    expect(await localRef()).toBe('');
    expect(state().states[RECEIVED]).toMatchObject({ kind: 'elsewhere' });
  });
});

describe('suppression d’un compte (K-01 critère 8)', () => {
  it('efface le jeton du coffre, le révoque, supprime le compte et ses événements', async () => {
    const accountId = await connected();
    const tokenRef = state().accounts[0]?.tokenRef ?? '';
    expect(await state().removeAccount(accountId)).toBe(true);
    expect(await h.container.calendars.vault.has(tokenRef)).toBe(false);
    expect(h.google.log).toContain('POST /revoke');
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
    expect(await titles()).toEqual([]);
    expect(state().accounts).toEqual([]);
    expect(state().states[accountId]).toBeUndefined();
  });
});

describe('hors ligne et limites (K-03 critère 5)', () => {
  it('une panne serveur garde les données et pose « Hors ligne » ; la tentative suivante vient à l’échéance', async () => {
    const accountId = await connected();
    h.google.failNext({ status: 503, pathPrefix: '/calendar' });
    h.db.clock.advance(60_000);
    await state().refresh(accountId, 'manual');
    expect(state().states[accountId]).toMatchObject({ kind: 'error', error: 'server' });
    expect(useAppStatusStore.getState().sources.offline).toBeDefined();
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
    h.db.clock.advance(5 * 60_000);
    expect(await state().refresh(accountId, 'tick')).toBe('skipped');
    h.db.clock.advance(11 * 60_000);
    expect(await state().refresh(accountId, 'tick')).toBe('done');
    expect(state().states[accountId]).toMatchObject({ kind: 'connected' });
    expect(useAppStatusStore.getState().sources.offline).toBeUndefined();
  });

  it('429 : le délai demandé est respecté, y compris par « Actualiser »', async () => {
    const accountId = await connected();
    h.google.failNext({ status: 429, retryAfterSeconds: 120, pathPrefix: '/calendar' });
    h.db.clock.advance(60_000);
    await state().refresh(accountId, 'manual');
    expect(state().states[accountId]).toMatchObject({ kind: 'error', error: 'rate-limited' });
    h.db.clock.advance(60_000);
    expect(await state().refresh(accountId, 'manual')).toBe('skipped');
    h.db.clock.advance(61_000);
    expect(await state().refresh(accountId, 'manual')).toBe('done');
  });

  it('jamais deux rafraîchissements parallèles du même compte ; un « Actualiser » pendant un autre est ignoré', async () => {
    const accountId = await connected();
    h.db.clock.advance(60_000);
    const before = h.google.log.length;
    const [first, second, third] = await Promise.all([state().refresh(accountId, 'manual'), state().refresh(accountId, 'manual'), state().refresh(accountId, 'open')]);
    expect([first, second, third].sort()).toEqual(['done', 'skipped', 'skipped']);
    expect(h.google.log.slice(before).filter((line) => line === 'GET /calendar/v3/calendars/ali.test%40example.com/events')).toHaveLength(1);
  });
});

describe('événements ajoutés, déplacés, supprimés côté serveur (K-03 critère 3)', () => {
  it('une relecture ajoute, déplace et retire sans doublon, en gardant l’identifiant de ligne', async () => {
    const accountId = await connected();
    const before = await h.container.data.repos.externalEvents.listBetween(wide);
    const client = before.find((event) => event.title === 'Point client');
    h.google.setEvents([
      { calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client (déplacé)', start: { dateTime: '2026-09-24T10:00:00+02:00' }, end: { dateTime: '2026-09-24T11:00:00+02:00' } },
      { calendarId: GOOGLE_ACCOUNT, id: 'nouveau', status: 'confirmed', summary: 'Nouveau', start: { dateTime: '2026-09-25T07:00:00Z' }, end: { dateTime: '2026-09-25T08:00:00Z' } },
    ]);
    h.db.clock.advance(60_000);
    await state().refresh(accountId, 'manual');
    const after = await h.container.data.repos.externalEvents.listBetween(wide);
    expect(after.map((event) => event.title)).toEqual(['Point client (déplacé)', 'Nouveau']);
    expect(after[0]?.id).toBe(client?.id);
    expect(after[0]?.startUtc).toBe('2026-09-24T08:00:00Z');
  });
});
