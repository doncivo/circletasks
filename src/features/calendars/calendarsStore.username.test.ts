import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER } from '../../../tests/sim';
import { asEntityId, type CalendarAccountId } from '../../domain/types';
import type { CalendarHttp, CalendarHttpRequest } from '../../platform/calendars';
import { useAppStatusStore } from '../app/appStatus';
import { calendarsStore, type CalendarsState } from './calendarsStore';
import { createProviderFor } from './providerFactory';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

/**
 * Identifiant Apple dans la colonne locale `username` (ADR 0011 section 8, audit M6, second audit point 9 ; Y-02 critère 10) :
 * un test par usage de l'ancien `label` (calendarsStore.ts lignes 122, 253, 385 ; providerFactory.ts).
 */

let h: CalendarHarness;
const state = (): CalendarsState => calendarsStore.get(h.container).getState();
const RECEIVED = asEntityId<CalendarAccountId>('94000000-0000-4000-8000-0000000000a1');
const RECEIVED_2 = asEntityId<CalendarAccountId>('94000000-0000-4000-8000-0000000000a2');

/** Compte iCloud reçu d'un autre appareil : `label` publié, ni identifiant Apple ni référence du coffre ici. */
async function receivedAccount(id: CalendarAccountId): Promise<void> {
  await h.container.data.repos.calendarAccounts.create({ id, provider: 'icloud', label: '', tokenRef: '', calendars: [] });
}

beforeEach(async () => {
  h = await setupCalendarHarness('31');
});
afterEach(() => h.close());

describe('calendar_account.username (Y-02 critère 10)', () => {
  it('compte reçu d’un autre appareil (aucune référence locale) : « connecté ailleurs », AUCUN bandeau « déconnecté », aucune lecture', async () => {
    await receivedAccount(RECEIVED);
    await state().load();
    await vi.waitFor(() => expect(state().states[RECEIVED]?.kind).toBe('elsewhere'));
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeFalsy();
    expect(useAppStatusStore.getState().sources.offline).toBeFalsy();
    expect(await state().refresh(RECEIVED, 'open')).toBe('skipped');
    expect(await state().refresh(RECEIVED, 'manual')).toBe('skipped');
    // « Connecter ici » : formulaire iCloud du compte reçu, identifiant à saisir.
    state().requestReconnect(RECEIVED);
    expect(state().icloudForm).toEqual({ accountId: RECEIVED, username: '' });
  });

  it('ligne 122 : compte de CET appareil dont le secret a disparu : bandeau « déconnecté » rapproché par identifiant de compte', async () => {
    const outcome = await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD);
    if (!outcome.ok) throw new Error(outcome.failure);
    const account = await h.container.data.repos.calendarAccounts.getById(outcome.accountId);
    if (!account) throw new Error('compte absent');
    await h.vault.delete(account.tokenRef);
    await state().load();
    await vi.waitFor(() => expect(state().states[outcome.accountId]?.kind).toBe('reconnect-required'));
    const banner = useAppStatusStore.getState().sources.calendarDisconnected;
    expect(banner?.detail).toBe(CALDAV_USER);
    banner?.onAction?.();
    expect(state().icloudForm).toEqual({ accountId: outcome.accountId, username: CALDAV_USER });
  });

  it('ligne 253 : doublon contrôlé sur username ; un compte reçu sans username est complété au lieu d’être recréé', async () => {
    await receivedAccount(RECEIVED);
    await state().load();
    const outcome = await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD);
    expect(outcome).toEqual({ ok: true, accountId: RECEIVED });
    const accounts = await h.container.data.repos.calendarAccounts.listAll();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: RECEIVED, username: CALDAV_USER, label: '', tokenRef: `circletasks.calendar.icloud.${RECEIVED}` });
    // Les colonnes locales complétées n'entrent pas dans la file d'envoi (rien n'est publié).
    expect(await h.db.driver.select("SELECT field FROM sync_outbox WHERE table_name = 'calendar_account' AND field <> '*'")).toEqual([]);
    expect(await state().connectIcloud(CALDAV_USER.toUpperCase(), CALDAV_APP_PASSWORD)).toEqual({ ok: false, failure: 'duplicate' });
  });

  it('ligne 253 : plusieurs comptes reçus sans username : l’utilisateur choisit (« Reconnecter » sur l’un d’eux)', async () => {
    await receivedAccount(RECEIVED);
    await receivedAccount(RECEIVED_2);
    await state().load();
    expect(await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD)).toEqual({ ok: false, failure: 'icloud-choose-account' });
    expect(await state().reconnectIcloud(RECEIVED_2, CALDAV_APP_PASSWORD, CALDAV_USER)).toEqual({ ok: true, accountId: RECEIVED_2 });
    const byId = new Map((await h.container.data.repos.calendarAccounts.listAll()).map((a) => [a.id, a]));
    expect(byId.get(RECEIVED_2)?.username).toBe(CALDAV_USER);
    expect(byId.get(RECEIVED)?.username).toBe('');
  });

  it('ligne 385 : formulaire de reconnexion pré-rempli avec username (vide pour un compte reçu)', async () => {
    const outcome = await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD);
    if (!outcome.ok) throw new Error(outcome.failure);
    state().requestReconnect(outcome.accountId);
    expect(state().icloudForm).toEqual({ accountId: outcome.accountId, username: CALDAV_USER });
  });

  it('providerFactory : l’identifiant Basic est lu dans username, jamais dans label', async () => {
    const requests: CalendarHttpRequest[] = [];
    const http: CalendarHttp = { request: async (request) => (requests.push(request), { status: 500, headers: {}, body: '' }) } as CalendarHttp;
    const provider = createProviderFor({ provider: 'icloud', tokenRef: 'circletasks.calendar.icloud.x', username: 'ali@icloud.com' }, { ...h.container.calendars, http }, () => 0, () => 'Europe/Paris');
    await provider.listCalendars();
    expect(requests[0]?.auth).toEqual({ kind: 'basic', tokenRef: 'circletasks.calendar.icloud.x', username: 'ali@icloud.com' });
  });
});
