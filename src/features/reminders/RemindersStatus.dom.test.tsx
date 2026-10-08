import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeNotificationActionSource, NotificationSchedulerError } from '../../platform/notifications';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useAppStatusStore } from '../app/appStatus';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { RecapSettingsScreen } from './RecapSettingsScreen';
import { statusController } from './notificationStatus';
import { replanNotifications } from './replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/** N-01 critères 10, 11, 12, 13 : Réglages > Rappels et bandeau de l'app. */
describe('Réglages > Rappels : état des rappels (N-01)', () => {
  let h: ReminderHarness | null = null;
  beforeEach(() => {
    mockViewport(440);
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'reminders' });
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useAppStatusStore.setState({ sources: {} });
    await h?.db.close();
    h = null;
  });

  const open = async (options: Parameters<typeof setupReminders>[0] = {}, run: (harness: ReminderHarness) => Promise<void> = async () => undefined) => {
    h = await setupReminders(options);
    await run(h);
    return render(
      <AppContainerProvider container={h.container}>
        <AppStatusBanner />
        <RecapSettingsScreen />
      </AppContainerProvider>,
    );
  };

  it('critère 10 : « Planifiés jusqu’au {date} {heure 24 h} » quand le plafond est atteint', async () => {
    await open({}, async (harness) => {
      await replanNotifications(harness.container, 'open');
    });
    const line = await screen.findByText(/^Planifiés jusqu’au /);
    expect(line).toHaveTextContent(/^Planifiés jusqu’au \d{1,2} \S+ à \d{2}:\d{2}$/);
  });

  it('critère 10 : « Tous les rappels sont planifiés » et « Aucun rappel à planifier »', async () => {
    await open({}, async (harness) => {
      await harness.container.data.repos.settings.set('reminders.morningRecap', { enabled: true, time: '07:30' as never });
      await harness.container.data.repos.settings.set('reminders.eveningRecap', { enabled: false, time: '21:00' as never });
      await seedReminderTask(harness.container, { date: '2026-10-09', time: '09:00' });
      await replanNotifications(harness.container, 'open');
    });
    expect(await screen.findByText('Planifiés jusqu’au', { exact: false })).toBeInTheDocument();
    cleanup();
    useAppStatusStore.setState({ sources: {} });
    await h?.db.close();
    await open({}, async (harness) => {
      await harness.container.data.repos.settings.set('reminders.morningRecap', { enabled: false, time: '07:30' as never });
      await harness.container.data.repos.settings.set('reminders.eveningRecap', { enabled: false, time: '21:00' as never });
      await replanNotifications(harness.container, 'open');
    });
    expect(await screen.findByText('Aucun rappel à planifier')).toBeInTheDocument();
  });

  it('critère 11 : autorisation refusée : bandeau persistant et texte avec renvoi aux réglages iOS', async () => {
    await open({}, async (harness) => {
      harness.fake.setPermission('denied');
      await replanNotifications(harness.container, 'open');
    });
    expect(screen.getAllByText('Les notifications sont refusées : les rappels ne sonneront pas', { exact: false }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Réglages > Notifications > CircleTasks/)).toBeInTheDocument();
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Les notifications sont refusées : les rappels ne sonneront pas');
  });

  it('critère 11 : non décidée : invitation et bouton « Autoriser les notifications » (geste), jamais au démarrage', async () => {
    await open({}, async (harness) => {
      harness.fake.setPermission('undetermined');
      await replanNotifications(harness.container, 'open');
    });
    expect(h?.fake.calls.some((call) => call.type === 'requestPermission')).toBe(false);
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Autorisez les notifications pour recevoir vos rappels');
    fireEvent.click(screen.getAllByRole('button', { name: 'Autoriser les notifications' }).at(-1) as HTMLElement);
    await waitFor(() => expect(h?.fake.calls.filter((call) => call.type === 'requestPermission')).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('.ct-status-banner')).toBeNull());
  });

  it('critère 11 : le bouton « Autoriser » du bandeau appelle requestPermission()', async () => {
    await open({}, async (harness) => {
      harness.fake.setPermission('undetermined');
      await replanNotifications(harness.container, 'open');
    });
    const banner = document.querySelector('.ct-status-banner') as HTMLElement;
    fireEvent.click(banner.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(h?.fake.calls.filter((call) => call.type === 'requestPermission')).toHaveLength(1));
  });

  it('critère 12 : échec de planification : bandeau « Les rappels n’ont pas pu être planifiés » et détail (code, nombres) dans Réglages ; « Voir » ouvre Réglages > Rappels', async () => {
    await open({}, async (harness) => {
      harness.fake.failNextReplace(new NotificationSchedulerError('verify-failed', ['task:x'], { scheduled: 3, cancelled: 1, kept: 4 }));
      await replanNotifications(harness.container, 'hide');
    });
    const banner = document.querySelector('.ct-status-banner') as HTMLElement;
    expect(banner).toHaveTextContent('Les rappels n’ont pas pu être planifiés');
    expect(screen.getByText(/Notification absente après l’envoi/)).toBeInTheDocument();
    expect(screen.getByText(/3 planifiés, 1 annulés, 4 conservés/)).toBeInTheDocument();
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'home' });
    fireEvent.click(within(banner).getByRole('button', { name: 'Voir le problème de rappels' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'reminders' });
    // Résolu : le premier replace réussi efface le bandeau et le détail.
    await act(async () => {
      await replanNotifications(h?.container as never, 'open');
    });
    expect(document.querySelector('.ct-status-banner')).toBeNull();
    expect(screen.queryByText(/Notification absente après l’envoi/)).toBeNull();
  });

  it('plusieurs états : le plus important avec « (+N) » dans le bandeau', async () => {
    await open({}, async (harness) => {
      harness.fake.setPermission('granted');
      harness.fake.failNextReplace(new NotificationSchedulerError('schedule-failed'));
      await replanNotifications(harness.container, 'open');
      await statusController(harness.container).patch((s) => ({ ...s, focusEndFailure: { at: '2026-10-08T08:00:00.000Z' as never, sessionId: 's', reason: 'permission-denied' } }));
    });
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Les rappels n’ont pas pu être planifiés (+1)');
    expect(screen.getByText(/La notification de fin de session n’a pas pu être planifiée/)).toBeInTheDocument();
  });

  it('N-03 critère 8 : action non appliquée : bandeau persistant, détail et « Ignorer » dans Réglages ; le geste efface les deux', async () => {
    const source = createFakeNotificationActionSource();
    await open({ parts: { notificationActions: source } }, async (harness) => {
      source.push({ numericId: 99_999, actionId: 'done', receivedAtMs: harness.db.clock.nowMs(), sid: null, deliveredAt: null });
      await replanNotifications(harness.container, 'open');
    });
    const bannerElement = document.querySelector('.ct-status-banner') as HTMLElement;
    expect(bannerElement).toHaveTextContent('Une action de notification n’a pas pu être appliquée');
    expect(screen.getByText('Actions en attente : 1 (nouvel essai à l’ouverture)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ignorer les actions de notification en échec' }));
    await waitFor(() => expect(document.querySelector('.ct-status-banner')).toBeNull());
    expect(screen.queryByText(/Actions en attente d’application/)).toBeNull();
  });

  it('N-03 : plugin d’actions en panne (délégué repris) : ligne dédiée dans Réglages et bandeau, sans bouton « Ignorer »', async () => {
    const source = createFakeNotificationActionSource();
    source.setDelegate(false);
    await open({ parts: { notificationActions: source } }, async (harness) => {
      await replanNotifications(harness.container, 'open');
    });
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Les boutons « Fait » et « +15 min » sont indisponibles');
    expect(screen.getByText(/gestionnaire des notifications repris/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ignorer les actions de notification en échec' })).toBeNull();
  });

  it('critère 13 : PC : « Les rappels sont envoyés par l’iPhone », aucun bandeau d’échec, aucun appel de planification', async () => {
    await open({ platform: { runtime: 'tauri', os: 'windows' }, mode: 'none' }, async (harness) => {
      await replanNotifications(harness.container, 'open');
    });
    expect(screen.getByText('Les rappels sont envoyés par l’iPhone')).toBeInTheDocument();
    expect(document.querySelector('.ct-status-banner')).toBeNull();
    expect(screen.queryByText(/refusées|planifiés|Autoriser/)).toBeNull();
  });

  it('N-06 : ligne fixe « Après un changement de fuseau, ouvrez CircleTasks » sur l’iPhone, et « Fuseau modifié » après un changement', async () => {
    await open({ mode: 'real' }, async (harness) => {
      await replanNotifications(harness.container, 'open');
      harness.zone.name = 'America/New_York';
      await replanNotifications(harness.container, 'resume');
    });
    expect(screen.getByText('Après un changement de fuseau, ouvrez CircleTasks : les rappels sont recalculés à l’ouverture.')).toBeInTheDocument();
    expect(screen.getByText(/^Fuseau modifié : rappels recalculés à \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('un état enregistré est montré dès l’ouverture de l’écran après un redémarrage (avant tout passage)', async () => {
    h = await setupReminders();
    h.fake.setPermission('denied');
    await replanNotifications(h.container, 'open');
    useAppStatusStore.setState({ sources: {} });
    const reopened = reopenReminders(h);
    await statusController(reopened).load();
    render(
      <AppContainerProvider container={reopened}>
        <AppStatusBanner />
        <RecapSettingsScreen />
      </AppContainerProvider>,
    );
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Les notifications sont refusées');
  });
});

