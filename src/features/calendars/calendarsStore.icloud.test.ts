import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER } from '../../../tests/sim';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { InstantRange } from '../../db/repositories';
import type { CalendarAccountId } from '../../domain/types';
import { useAppStatusStore } from '../app/appStatus';
import { calendarsStore, type CalendarsState } from './calendarsStore';
import { dumpDatabaseText, setupCalendarHarness, type CalendarHarness } from './testKit';

const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;

let h: CalendarHarness;
const store = () => calendarsStore.get(h.container);
const state = (): CalendarsState => store().getState();
const idle = (): Promise<void> => vi.waitFor(() => expect(state().refreshing).toEqual([]));
const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((event) => event.title).sort();

async function connected(): Promise<CalendarAccountId> {
  const outcome = await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD);
  if (!outcome.ok) throw new Error(`connexion refusée : ${outcome.failure}`);
  await vi.waitFor(() => expect(state().states[outcome.accountId]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await idle();
  return outcome.accountId;
}

beforeEach(async () => {
  h = await setupCalendarHarness('21');
});
afterEach(() => h.close());

describe('connexion iCloud (K-02)', () => {
  it('crée le compte (label = identifiant), range le mot de passe au coffre, liste les seuls agendas d’événements, charge les événements (critères 2, 4, 5)', async () => {
    const accountId = await connected();
    const [account] = await h.container.data.repos.calendarAccounts.listAll();
    expect(account).toMatchObject({ id: accountId, provider: 'icloud', label: CALDAV_USER, tokenRef: `circletasks.calendar.${accountId}` });
    expect(account?.calendars).toEqual([{ id: '/1234567/calendars/famille/', name: 'Famille', spaceId: SPACE_PRO_ID, shown: true }]);
    expect(await h.container.calendars.vault.has(account?.tokenRef ?? '')).toBe(true);
    expect(await titles()).toEqual(['', 'Dîner chez Leïla', 'Marché', 'Piscine', 'Piscine', 'Week-end à Tunis']);
  });

  it('le mot de passe n’apparaît ni dans la base, ni dans l’état, ni dans le journal du simulateur (critère 7)', async () => {
    await connected();
    expect(await dumpDatabaseText(h.db)).not.toContain(CALDAV_APP_PASSWORD);
    expect(JSON.stringify({ ...state() })).not.toContain(CALDAV_APP_PASSWORD);
    expect(h.caldav.log.join('\n')).not.toContain(CALDAV_APP_PASSWORD);
  });

  it('401 : « identifiant ou mot de passe incorrect », rien d’enregistré, rien dans le coffre (critère 3)', async () => {
    expect(await state().connectIcloud(CALDAV_USER, 'mauvais')).toEqual({ ok: false, failure: 'icloud-invalid' });
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
    expect(h.vault.refs()).toEqual([]);
  });

  it('serveur injoignable : « Impossible de joindre iCloud », aucun compte créé (critère 3)', async () => {
    await h.caldav.close();
    expect(await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD)).toEqual({ ok: false, failure: 'icloud-unreachable' });
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('champs vides ou compte déjà connecté : refusés', async () => {
    expect(await state().connectIcloud('', 'x')).toEqual({ ok: false, failure: 'icloud-invalid' });
    expect(await state().connectIcloud(CALDAV_USER, '')).toEqual({ ok: false, failure: 'icloud-invalid' });
    await connected();
    expect(await state().connectIcloud(CALDAV_USER.toUpperCase(), CALDAV_APP_PASSWORD)).toEqual({ ok: false, failure: 'duplicate' });
  });
});

describe('mot de passe révoqué (K-02 critère 6, A-09)', () => {
  it('401 au rafraîchissement : « Déconnecté », alerte « Reconnecter » qui rouvre le formulaire pré-rempli ; le bon mot de passe rétablit le compte', async () => {
    const accountId = await connected();
    h.caldav.setPassword('nouveau-mot-de-passe');
    h.db.clock.advance(60_000);
    await state().refresh(accountId, 'manual');
    expect(state().states[accountId]).toMatchObject({ kind: 'reconnect-required' });
    expect(await titles()).toHaveLength(6);
    useAppStatusStore.getState().sources.calendarDisconnected?.onAction?.();
    expect(state().icloudForm).toEqual({ accountId, username: CALDAV_USER });
    expect(await state().reconnectIcloud(accountId, 'encore-faux')).toEqual({ ok: false, failure: 'icloud-invalid' });
    expect(state().icloudForm).not.toBeNull();
    expect(await state().reconnectIcloud(accountId, 'nouveau-mot-de-passe')).toEqual({ ok: true, accountId });
    await vi.waitFor(() => expect(state().states[accountId]).toMatchObject({ kind: 'connected' }));
    await idle();
    expect(state().icloudForm).toBeNull();
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeUndefined();
  });
});

describe('suppression et ctag (K-02 critère 8, K-03 D1)', () => {
  it('supprimer le compte efface le mot de passe du coffre et les événements', async () => {
    const accountId = await connected();
    const tokenRef = state().accounts[0]?.tokenRef ?? '';
    expect(await state().removeAccount(accountId)).toBe(true);
    expect(await h.container.calendars.vault.has(tokenRef)).toBe(false);
    expect(await titles()).toEqual([]);
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('ctag inchangé : le rafraîchissement suivant ne relit pas les événements ; un changement serveur les met à jour', async () => {
    const accountId = await connected();
    h.db.clock.advance(60_000);
    h.caldav.log.length = 0;
    await state().refresh(accountId, 'manual');
    expect(h.caldav.log.some((line) => line.startsWith('REPORT'))).toBe(false);
    h.caldav.setObjects('famille', []);
    h.db.clock.advance(60_000);
    await state().refresh(accountId, 'manual');
    expect(h.caldav.log.some((line) => line.startsWith('REPORT'))).toBe(true);
    expect(await titles()).toEqual([]);
  });

  it('les événements restent en lecture seule : aucune requête d’écriture vers iCloud (critère 8)', async () => {
    await connected();
    expect(h.caldav.log.every((line) => line.startsWith('PROPFIND ') || line.startsWith('REPORT ') || line.startsWith('GET /.well-known'))).toBe(true);
  });
});
