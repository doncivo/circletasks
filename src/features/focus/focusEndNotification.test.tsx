import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotificationStatus, type NotificationStatusV1 } from '../../domain/notificationStatus';
import { createFakeFocusEndScheduler, type FocusEndScheduler } from '../../platform/focus';
import { createTauriFocusEndScheduler } from '../../platform/focus/tauriFocusEnd';
import { createFakeBridge, type FakeBridge } from '../../platform/notifications/fakeBridge';
import { createTauriNotificationScheduler } from '../../platform/notifications/tauriNotifications';
import { NotificationSchedulerError } from '../../platform/notifications';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { composeFocusEndText } from '../reminders/focusEndText';
import { statusController } from '../reminders/notificationStatus';
import { replanNotifications } from '../reminders/replanNotifications';
import { FocusHost } from './FocusHost';
import { focusStore } from './focusStore';
import { MIN, reopen, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

/**
 * F-04 critères 11 à 17 (complément ordre 5) : la notification de fin de session part de l'iPhone par l'adaptateur réel (faux pont iOS),
 * identifiant numérique 1, sans plage silencieuse, et son échec n'est plus avalé. La session démarre le dimanche 2026-10-04 à 10:00 à Paris.
 */
const banner = () => useAppStatusStore.getState().sources.remindersTrouble;

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('Fin de Focus : adaptateur réel sur l’iPhone (F-04 critères 11 à 16)', () => {
  let h: FocusHarness;
  let bridge: FakeBridge;
  let zone: string | null;

  const clock = () => ({ nowMs: () => h.db.clock.nowMs(), zone: () => zone });
  function containerWith(extra: { focus?: FocusEndScheduler } = {}): AppContainer {
    const base = reopen(h, { platform: { runtime: 'tauri', os: 'ios' }, notificationClock: clock() });
    const focus = extra.focus ?? createTauriFocusEndScheduler({ bridge, ledger: base.notificationLedger, clock: clock(), compose: composeFocusEndText });
    return reopen(h, {
      platform: { runtime: 'tauri', os: 'ios' },
      notificationClock: clock(),
      notificationLedger: base.notificationLedger,
      notifications: createTauriNotificationScheduler({ bridge, ledger: base.notificationLedger, clock: clock() }),
      focusEndScheduler: focus,
    });
  }

  beforeEach(async () => {
    zone = 'Europe/Paris';
    bridge = createFakeBridge();
    h = await setupFocus('4f4', {}, '2026-10-04T08:00:00.000Z');
    useAppStatusStore.setState({ sources: {} });
  });
  afterEach(() => h.db.close());

  const start = async (c: AppContainer, title = 'Envoyer la facture', over: { spaceId?: never } = {}) => {
    const task = await seedFocusTask(c, title, over);
    await focusStore.get(c).getState().start(task.id);
    return task;
  };
  const pendingFocus = () => bridge.pendingMap.get(1);
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  };

  it('critères 11 et 12 : lancement, pause, reprise, changement de durée, arrêt : identifiant 1 à début + durée (heure murale de Paris), annulé à la pause et à l’arrêt', async () => {
    const c = containerWith();
    await start(c);
    await flush();
    expect(pendingFocus()).toMatchObject({ id: 1, title: 'Session terminée · 25 min', body: 'Envoyer la facture', date: '2026-10-04T10:25:00.000Z' });
    const store = focusStore.get(c);
    h.db.clock.advance(10 * MIN);
    await store.getState().pause();
    await flush();
    expect(pendingFocus()).toBeUndefined();
    h.db.clock.advance(20 * MIN);
    await store.getState().resume();
    await flush();
    expect(pendingFocus()?.date).toBe('2026-10-04T10:45:00.000Z');
    await store.getState().setDuration(50);
    await flush();
    expect(pendingFocus()).toMatchObject({ title: 'Session terminée · 50 min', date: '2026-10-04T11:10:00.000Z' });
    expect([...bridge.pendingMap.keys()]).toEqual([1]);
    await store.getState().stop();
    await flush();
    expect(bridge.pendingMap.size).toBe(0);
  });

  it('critère 12 : « Terminer la tâche » et redémarrage avec une session ouverte (replanifiée, une seule notification)', async () => {
    const first = containerWith();
    await start(first);
    await flush();
    h.db.clock.advance(5 * MIN);
    const second = containerWith();
    await focusStore.get(second).getState().restore();
    await flush();
    expect(bridge.pendingMap.size).toBe(1);
    expect(pendingFocus()?.date).toBe('2026-10-04T10:25:00.000Z');
    await focusStore.get(second).getState().finishTask();
    await flush();
    expect(bridge.pendingMap.size).toBe(0);
  });

  it('critère 12 : un fireAt déjà passé (ou dans la marge de 5 s) n’est pas envoyé', async () => {
    const first = containerWith();
    await start(first);
    await flush();
    const sent = bridge.shown.length;
    h.db.clock.advance(25 * MIN - 2000); // le terme est dans 2 s
    const second = containerWith();
    await focusStore.get(second).getState().restore();
    await flush();
    expect(bridge.shown).toHaveLength(sent);
  });

  it('critère 13 : un passage de replanNotifications ne retire jamais l’identifiant 1 et réduit limit de 1 tant qu’une session est planifiée', async () => {
    const c = containerWith();
    await start(c);
    await flush();
    const outcome = await replanNotifications(c, 'open');
    expect(outcome).toMatchObject({ status: 'planned', report: { scheduled: 63 } });
    expect(bridge.pendingMap.has(1)).toBe(true);
    expect(bridge.pendingMap.size).toBe(64);
    await replanNotifications(c, 'resume');
    expect(bridge.pendingMap.has(1)).toBe(true);
    expect(bridge.cancels.flat()).not.toContain(1);
  });

  it('critère 14 : ni plages silencieuses ni Ne pas déranger ne décalent la fin (session finissant à 22:30 dans l’espace Pro, plages 20:00–08:00)', async () => {
    h.db.clock.set('2026-10-04T20:05:00.000Z'); // 22:05 à Paris
    const c = containerWith();
    await start(c); // espace Pro par défaut de seedFocusTask
    await flush();
    expect(pendingFocus()?.date).toBe('2026-10-04T22:30:00.000Z');
  });

  it('critère 16 : fin vécue app ouverte : la notification de la session est annulée (pas de double alerte son + bannière)', async () => {
    const c = containerWith();
    await start(c);
    await flush();
    expect(bridge.pendingMap.size).toBe(1);
    h.db.clock.advance(25 * MIN);
    await focusStore.get(c).getState().checkElapsed();
    await flush();
    expect(bridge.pendingMap.size).toBe(0);
    expect(bridge.cancels.at(-1)).toEqual([1]);
  });

  it('critère 16 : fin app fermée : la notification déjà sonnée n’est pas rejouée ; l’ouverture suivante affiche « Session terminée » sans son', async () => {
    const first = containerWith();
    await start(first);
    await flush();
    // L'app est tuée ; iOS fait sonner la notification de 10:25 (elle quitte la liste en attente).
    bridge.pendingMap.delete(1);
    h.db.clock.advance(30 * MIN);
    const shown = bridge.shown.length;
    const second = containerWith();
    await focusStore.get(second).getState().restore();
    await flush();
    expect(focusStore.get(second).getState().ended?.minutes).toBe(25);
    expect(focusStore.get(second).getState().soundNonce).toBe(0);
    expect(bridge.shown).toHaveLength(shown);
  });
});

describe('Fin de Focus : échec visible, persistant, effacé (F-04 critère 15)', () => {
  let h: FocusHarness;
  let bridge: FakeBridge;
  const status = async (c: AppContainer): Promise<NotificationStatusV1> => {
    const read = parseNotificationStatus(await c.data.repos.settings.get('notifications.status'));
    if (read.state !== 'valid') throw new Error('état illisible');
    return read.status;
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  };
  const containerFor = (): AppContainer => {
    const base = reopen(h, { platform: { runtime: 'tauri', os: 'ios' } });
    return reopen(h, {
      platform: { runtime: 'tauri', os: 'ios' },
      notificationLedger: base.notificationLedger,
      focusEndScheduler: createTauriFocusEndScheduler({
        bridge,
        ledger: base.notificationLedger,
        clock: { nowMs: () => h.db.clock.nowMs(), zone: () => 'Europe/Paris' },
        compose: composeFocusEndText,
      }),
    });
  };

  beforeEach(async () => {
    bridge = createFakeBridge();
    h = await setupFocus('4f5', {}, '2026-10-04T08:00:00.000Z');
    useAppStatusStore.setState({ sources: {} });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.db.close();
  });

  it('autorisation refusée : code écrit (session, heure, jamais le titre), bandeau, la session continue ; effacé à la reprise réussie', async () => {
    bridge.permissionState = 'denied';
    const c = containerFor();
    const task = await seedFocusTask(c, 'Titre confidentiel');
    await focusStore.get(c).getState().start(task.id);
    await flush();
    const session = focusStore.get(c).getState().session;
    expect(session).not.toBeNull();
    const failure = (await status(c)).focusEndFailure;
    expect(failure).toEqual({ at: '2026-10-04T08:00:00.000Z', sessionId: session?.id, reason: 'permission-denied' });
    expect(JSON.stringify(await status(c))).not.toContain('Titre confidentiel');
    expect(banner()?.message).toBe('La notification de fin de session n’a pas pu être planifiée');

    // Persistant : survit à un redémarrage.
    useAppStatusStore.setState({ sources: {} });
    const reopened = containerFor();
    await statusController(reopened).load();
    expect(banner()?.message).toBe('La notification de fin de session n’a pas pu être planifiée');

    // L'autorisation est rétablie ; la pause puis la reprise replanifient avec succès : l'échec disparaît.
    bridge.permissionState = 'granted';
    await focusStore.get(reopened).getState().restore();
    await flush();
    expect((await status(reopened)).focusEndFailure).toBeNull();
    expect(banner()).toBeUndefined();
    expect(bridge.pendingMap.has(1)).toBe(true);
  });

  it('chaque code d’échec de l’adaptateur est écrit : envoi refusé, notification absente, registre non écrit', async () => {
    const cases: [string, (b: FakeBridge) => void][] = [
      ['schedule-failed', (b) => void (b.failShow = () => true)],
      ['verify-failed', (b) => void (b.dropOnShow = () => true)],
    ];
    for (const [reason, arrange] of cases) {
      const fresh = createFakeBridge();
      bridge = fresh;
      arrange(fresh);
      const c = containerFor();
      useAppStatusStore.setState({ sources: {} });
      const task = await seedFocusTask(c, `T ${reason}`);
      await focusStore.get(c).getState().start(task.id);
      await flush();
      expect((await status(c)).focusEndFailure?.reason, reason).toBe(reason);
      await focusStore.get(c).getState().stop();
      await flush();
    }
  });

  it('la clôture de la session efface l’échec (puis l’annulation réussie le laisse effacé)', async () => {
    bridge.permissionState = 'denied';
    const c = containerFor();
    const task = await seedFocusTask(c, 'Fin');
    await focusStore.get(c).getState().start(task.id);
    await flush();
    expect((await status(c)).focusEndFailure).not.toBeNull();
    bridge.permissionState = 'granted';
    h.db.clock.advance(25 * MIN);
    await focusStore.get(c).getState().checkElapsed();
    await flush();
    expect((await status(c)).focusEndFailure).toBeNull();
    expect(banner()).toBeUndefined();
  });

  it('un rejet inattendu du planificateur (sans code) est écrit schedule-failed ; le critère 9 d’origine reste vrai (la session n’est pas interrompue)', async () => {
    const fake = createFakeFocusEndScheduler();
    fake.failNext(new Error('boom'));
    const c = reopen(h, { platform: { runtime: 'tauri', os: 'ios' }, focusEndScheduler: fake });
    const task = await seedFocusTask(c, 'X');
    expect(await focusStore.get(c).getState().start(task.id)).toBe('started');
    await flush();
    expect((await status(c)).focusEndFailure?.reason).toBe('schedule-failed');
    expect(focusStore.get(c).getState().session).not.toBeNull();
    // Le prochain schedule réussi (pause puis reprise) efface.
    await focusStore.get(c).getState().pause();
    await flush();
    expect((await status(c)).focusEndFailure).toBeNull();
  });

  it('écran Focus : un bandeau persistant annonce l’échec, la session et l’anneau restent affichés', async () => {
    mockViewport(390);
    const fake = createFakeFocusEndScheduler();
    fake.failNext(new NotificationSchedulerError('permission-denied'));
    const c = reopen(h, { platform: { runtime: 'tauri', os: 'ios' }, focusEndScheduler: fake });
    const task = await seedFocusTask(c, 'Envoyer la facture');
    render(
      <AppContainerProvider container={c}>
        <FocusHost />
      </AppContainerProvider>,
    );
    await act(async () => {
      await focusStore.get(c).getState().start(task.id);
      await flush();
    });
    expect(await screen.findByRole('region', { name: 'Session Focus' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('La notification de fin de session n’a pas pu être planifiée')).toBeVisible());
    // Pause puis reprise : le schedule réussit, le bandeau disparaît.
    await act(async () => {
      await focusStore.get(c).getState().pause();
      await focusStore.get(c).getState().resume();
      await flush();
    });
    await waitFor(() => expect(screen.queryByText('La notification de fin de session n’a pas pu être planifiée')).toBeNull());
    cleanup();
    vi.unstubAllGlobals();
  });

});
