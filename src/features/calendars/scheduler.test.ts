import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNT, type GoogleSimEvent } from '../../../tests/sim';
import type { InstantRange } from '../../db/repositories';
import { useAppStatusStore } from '../app/appStatus';
import { calendarsStore } from './calendarsStore';
import { POLL_INTERVAL_MS, startCalendarScheduler, type CalendarScheduler, type SchedulerEnv } from './scheduler';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

/** Planificateur K-03 : horloge manuelle, minuteur et premier plan simulés, simulateur Google : aucun `sleep` réel. */
const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;
const MIN = 60_000;

let h: CalendarHarness;
let scheduler: CalendarScheduler | null = null;
let visibility: 'visible' | 'hidden' = 'visible';
let timerHandler: (() => void) | null = null;
let cleared = 0;

const env: SchedulerEnv = {
  document: {
    get visibilityState() {
      return visibility;
    },
  } as SchedulerEnv['document'],
  setInterval: (handler) => {
    timerHandler = handler;
    return 1;
  },
  clearInterval: () => void (cleared += 1),
};

const state = () => calendarsStore.get(h.container).getState();
const idle = (): Promise<void> => vi.waitFor(() => expect(state().refreshing).toEqual([]));
const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((event) => event.title).sort();
const eventsRequests = (): number => h.google.log.filter((line) => line.includes('/events')).length;

const event = (id: string, summary: string): GoogleSimEvent => ({ calendarId: GOOGLE_ACCOUNT, id, status: 'confirmed', summary, start: { dateTime: '2026-09-24T08:00:00Z' }, end: { dateTime: '2026-09-24T09:00:00Z' } });

/** Un compte connecté et lu une fois, puis l'horloge avance d'une minute. */
async function connectedAccount(): Promise<void> {
  const outcome = await state().connectGoogle();
  expect(outcome.ok).toBe(true);
  await vi.waitFor(() => expect(Object.values(state().states)[0]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await idle();
}

beforeEach(async () => {
  visibility = 'visible';
  timerHandler = null;
  cleared = 0;
  h = await setupCalendarHarness('31');
});
afterEach(async () => {
  scheduler?.dispose();
  scheduler = null;
  await h.close();
});

describe('rafraîchissement à l’ouverture (K-03 critère 1)', () => {
  it('lit chaque compte connecté dès le démarrage', async () => {
    await connectedAccount();
    h.google.setEvents([event('nouveau', 'Nouveau')]);
    h.db.clock.advance(MIN);
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    expect(await titles()).toEqual(['Nouveau']);
    expect(timerHandler).not.toBeNull();
  });

  it('un compte sans secret sur cet appareil n’est pas lu : « à reconnecter » sans requête (K-01 D1)', async () => {
    await connectedAccount();
    const tokenRef = state().accounts[0]?.tokenRef ?? '';
    await h.container.calendars.vault.delete(tokenRef);
    const before = h.google.log.length;
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    expect(Object.values(state().states)[0]).toMatchObject({ kind: 'reconnect-required' });
    expect(h.google.log.length).toBe(before);
  });
});

describe('échéance de 15 min au premier plan (K-03 critère 2, D3)', () => {
  it('rien avant 15 min depuis la dernière réussite, un rafraîchissement ensuite, puis 15 min de plus', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    const base = eventsRequests();
    h.google.setEvents([event('e1', 'Premier')]);
    h.db.clock.advance(14 * MIN + 30_000);
    await scheduler.tick();
    expect(eventsRequests()).toBe(base);
    expect(await titles()).not.toContain('Premier');
    h.db.clock.advance(30_000);
    await timerHandler?.();
    await idle();
    expect(await titles()).toEqual(['Premier']);
    const afterFirst = eventsRequests();
    h.db.clock.advance(14 * MIN);
    await scheduler.tick();
    expect(eventsRequests()).toBe(afterFirst);
    h.db.clock.advance(MIN);
    await scheduler.tick();
    expect(eventsRequests()).toBeGreaterThan(afterFirst);
  });

  it('aucun rafraîchissement en arrière-plan ; retour au premier plan après plus de 15 min : lecture immédiate', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    const base = eventsRequests();
    visibility = 'hidden';
    h.db.clock.advance(60 * MIN);
    await scheduler.tick();
    await scheduler.resume();
    expect(eventsRequests()).toBe(base);
    h.google.setEvents([event('e2', 'Revenu')]);
    visibility = 'visible';
    await scheduler.resume();
    await vi.waitFor(async () => expect(await titles()).toEqual(['Revenu']));
  });

  it('retour au premier plan avant 15 min : pas de lecture', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    const base = eventsRequests();
    h.db.clock.advance(5 * MIN);
    await scheduler.resume();
    await idle();
    expect(eventsRequests()).toBe(base);
  });

  it('le sondage se fait toutes les 30 s ; arrêt propre', async () => {
    scheduler = startCalendarScheduler(h.container, env);
    expect(POLL_INTERVAL_MS).toBe(30_000);
    scheduler.dispose();
    scheduler.dispose();
    expect(cleared).toBe(1);
    scheduler = null;
  });
});

describe('pannes (K-03 critères 5 et 6)', () => {
  it('panne serveur : données gardées, « Hors ligne », nouvelle tentative à la prochaine échéance seulement', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    h.db.clock.advance(15 * MIN);
    h.google.failNext({ status: 503, pathPrefix: '/calendar' });
    await scheduler.tick();
    expect(Object.values(state().states)[0]).toMatchObject({ kind: 'error', error: 'server' });
    expect(useAppStatusStore.getState().sources.offline).toBeDefined();
    expect((await titles()).length).toBeGreaterThan(0);
    const base = eventsRequests();
    h.db.clock.advance(10 * MIN);
    await scheduler.tick();
    expect(eventsRequests()).toBe(base);
    h.db.clock.advance(5 * MIN);
    await scheduler.tick();
    expect(Object.values(state().states)[0]).toMatchObject({ kind: 'connected' });
    expect(useAppStatusStore.getState().sources.offline).toBeUndefined();
  });

  it('401 : « à reconnecter » puis plus aucune tentative automatique, ni échéance ni ouverture', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    h.google.revokeAll();
    h.db.clock.advance(15 * MIN);
    await scheduler.tick();
    expect(Object.values(state().states)[0]).toMatchObject({ kind: 'reconnect-required' });
    const base = h.google.log.length;
    for (let index = 0; index < 5; index += 1) {
      h.db.clock.advance(15 * MIN);
      await scheduler.tick();
    }
    await state().refreshAll('open');
    expect(h.google.log.length).toBe(base);
  });

  it('arrêt : les états posés par les agendas sont retirés du cadre d’état', async () => {
    await connectedAccount();
    scheduler = startCalendarScheduler(h.container, env);
    await scheduler.ready;
    await idle();
    h.google.revokeAll();
    h.db.clock.advance(15 * MIN);
    await scheduler.tick();
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeDefined();
    scheduler.dispose();
    expect(useAppStatusStore.getState().sources.calendarDisconnected).toBeUndefined();
    scheduler = null;
  });
});

