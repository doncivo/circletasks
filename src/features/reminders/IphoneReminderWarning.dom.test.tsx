import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import type { DeviceId, IsoDateTime } from '../../domain/types';
import { asLocalDate, asLocalTime } from '../../domain/types';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { createFakeSyncService, type FakeSyncService } from '../sync/testKit';
import { IphoneReminderWarning, WARNING_TICK_MS } from './IphoneReminderWarning';
import { RecapSettingsScreen } from './RecapSettingsScreen';
import { replanNotifications } from './replanNotifications';
import { seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/** N-07 critères 6 à 9 : avertissement affiché par le PC (il ne planifie rien, il avertit). Horloge de l'app : 2026-10-08 10:00 à Paris. */
const NOW = Date.parse('2026-10-08T08:00:00.000Z');
const iso = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

const pcDevice: SyncDeviceStatus = { deviceId: 'pc' as DeviceId, platform: 'windows', self: true, lastReadAt: null, status: 'active' };
const iphone = (publishedAgoMs: number | null, over: Partial<SyncDeviceStatus> = {}): SyncDeviceStatus => ({
  deviceId: 'iphone' as DeviceId,
  platform: 'ios',
  self: false,
  lastReadAt: iso(NOW),
  status: 'active',
  publishedSyncAt: publishedAgoMs === null ? null : iso(NOW - publishedAgoMs),
  ...over,
});

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('Avertissement du PC : un rappel proche que l’iPhone n’a peut-être pas reçu (N-07)', () => {
  let h: ReminderHarness;
  let sync: FakeSyncService;
  beforeEach(async () => {
    mockViewport(1440);
    sync = createFakeSyncService({ phase: 'idle', devices: [pcDevice, iphone(5 * 60_000)] });
    h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
    h = { ...h, container: createContainerFor(h, sync, 'windows') };
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [] });
    await h.db.close();
  });

  const warningProps = (time: string, offsets: readonly number[] = [0]) => ({
    spaceId: SPACE_PERSO_ID,
    date: asLocalDate('2026-10-08'),
    time: asLocalTime(time),
    offsets: offsets as never,
  });
  const show = (props: ReturnType<typeof warningProps>, container: AppContainer = h.container) =>
    render(
      <AppContainerProvider container={container}>
        <IphoneReminderWarning {...props} />
      </AppContainerProvider>,
    );

  it('critère 5 : iPhone synchronisé depuis moins de 2 h : aucun avertissement', () => {
    show(warningProps('10:30'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('critères 4 et 7 : iPhone sans synchro publiée depuis plus de 2 h 30 et rappel dans moins de 2 h : « pourrait ne pas sonner à l’heure »', () => {
    act(() => sync.setStatus({ devices: [pcDevice, iphone(3 * 3_600_000)] }));
    show(warningProps('10:30'));
    expect(screen.getByRole('status')).toHaveTextContent('L’iPhone ne s’est pas synchronisé depuis plus de 2 h : ce rappel pourrait ne pas sonner à l’heure');
  });

  it('critère 7 : disparaît quand l’iPhone se synchronise (phase suivante de SyncStatus)', () => {
    act(() => sync.setStatus({ devices: [pcDevice, iphone(3 * 3_600_000)] }));
    show(warningProps('10:30'));
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => sync.setStatus({ phase: 'syncing', devices: [pcDevice, iphone(2 * 60_000)] }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('critère 5 : un rappel à plus de 2 h : aucun avertissement même si l’iPhone est ancien', () => {
    act(() => sync.setStatus({ devices: [pcDevice, iphone(10 * 3_600_000)] }));
    show(warningProps('12:30'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('critère 6 : aucun iPhone associé : « Aucun iPhone associé : ce rappel ne sonnera pas » ; synchro non configurée de même', () => {
    act(() => sync.setStatus({ devices: [pcDevice] }));
    const first = show(warningProps('10:30'));
    expect(screen.getByRole('status')).toHaveTextContent('Aucun iPhone associé : ce rappel ne sonnera pas');
    first.unmount();
    show(warningProps('10:30'), createContainerFor(h, null, 'windows'));
    expect(screen.getByRole('status')).toHaveTextContent('Aucun iPhone associé : ce rappel ne sonnera pas');
  });

  it.each(['forgotten', 'expired', 'corrupt'] as const)('critère 8 : un iPhone %s compte comme non synchronisé', (status) => {
    act(() => sync.setStatus({ devices: [pcDevice, iphone(60_000, { status })] }));
    show(warningProps('10:30'));
    expect(screen.getByRole('status')).toHaveTextContent('ne s’est pas synchronisé');
  });

  it('critère 9 : sur l’iPhone, aucun avertissement N-07 (la planification y est locale)', () => {
    act(() => sync.setStatus({ devices: [pcDevice] }));
    const phone = createContainerFor(h, sync, 'ios');
    show(warningProps('10:30'), phone);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('sans heure, sans avance ou sans date : aucun avertissement', () => {
    act(() => sync.setStatus({ devices: [pcDevice] }));
    const { rerender } = show({ ...warningProps('10:30'), offsets: [] as never });
    expect(screen.queryByRole('status')).toBeNull();
    rerender(
      <AppContainerProvider container={h.container}>
        <IphoneReminderWarning spaceId={SPACE_PERSO_ID} date={null} time={null} offsets={[0]} />
      </AppContainerProvider>,
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('l’échéance effective compte : un rappel Pro à 20:30 décalé au lendemain 08:00 n’avertit pas', () => {
    act(() => sync.setStatus({ devices: [pcDevice] }));
    h.db.clock.set('2026-10-08T17:45:00.000Z'); // 19:45 à Paris : le rappel Pro de 20:30 est dans 45 min, mais décalé à demain 08:00
    show({ ...warningProps('20:30'), spaceId: '00000000-0000-4000-8000-000000000001' as never });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('recalculé à chaque minute par l’horloge de l’application ; la minuterie est arrêtée au démontage', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    act(() => sync.setStatus({ devices: [pcDevice] }));
    // 12:01 : dans 2 h 01, hors fenêtre.
    const view = show(warningProps('12:01'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    h.db.clock.advance(2 * 60_000);
    act(() => void vi.advanceTimersByTime(WARNING_TICK_MS));
    expect(screen.getByRole('status')).toHaveTextContent('Aucun iPhone associé');
    // Le rappel est passé : l’avertissement disparaît.
    h.db.clock.advance(3 * 3_600_000);
    act(() => void vi.advanceTimersByTime(WARNING_TICK_MS));
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createContainerFor(h: ReminderHarness, sync: FakeSyncService | null, os: 'ios' | 'windows'): AppContainer {
  return createAppContainer({
    clock: h.db.clock,
    hlc: h.container.hlc,
    data: h.db.data,
    platform: { runtime: 'tauri', os },
    notifications: h.container.notifications,
    notificationClock: h.container.notificationClock,
    sync,
  });
}

describe('Réglages > Rappels sur le PC : nombre de rappels concernés dans les 2 h (N-07 critère 7)', () => {
  let h: ReminderHarness;
  let sync: FakeSyncService;
  beforeEach(async () => {
    mockViewport(1440);
    sync = createFakeSyncService({ phase: 'idle', devices: [pcDevice] });
    h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
    h = { ...h, container: createContainerFor(h, sync, 'windows') };
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [] });
    await h.db.close();
  });

  it('lecture impossible : journalisée (warning-read-failed) et ligne visible, jamais un silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(h.container.data.repos.reminders, 'listBetween').mockRejectedValue(new Error('illisible'));
    await replanNotifications(h.container, 'open');
    render(
      <AppContainerProvider container={h.container}>
        <RecapSettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Les rappels proches n’ont pas pu être vérifiés', { exact: false })).toBeInTheDocument();
    expect(warn.mock.calls.flat().join(' ')).toContain('warning-read-failed');
    warn.mockRestore();
  });

  it('compte les rappels de tâches à faire des 2 prochaines heures ; une tâche terminée n’est pas comptée ; disparaît quand l’iPhone se synchronise', async () => {
    await seedReminderTask(h.container, { title: 'A', date: '2026-10-08', time: '10:30' });
    const done = await seedReminderTask(h.container, { title: 'B', date: '2026-10-08', time: '11:00' });
    await seedReminderTask(h.container, { title: 'C', date: '2026-10-08', time: '15:00' });
    await h.container.data.repos.tasks.complete(done.id, '2026-10-08T08:05:00.000Z' as never);
    await replanNotifications(h.container, 'open');
    render(
      <AppContainerProvider container={h.container}>
        <RecapSettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Les rappels sont envoyés par l’iPhone')).toBeInTheDocument();
    expect(await screen.findByText('Aucun iPhone associé : 1 rappel dans les 2 prochaines heures ne sonnera pas')).toBeInTheDocument();
    // L'iPhone s'associe et se synchronise : l'avertissement disparaît.
    act(() => sync.setStatus({ devices: [pcDevice, iphone(60_000)] }));
    await vi.waitFor(() => expect(screen.queryByText(/dans les 2 prochaines heures/)).toBeNull());
    // Il cesse de se synchroniser : l'avertissement revient avec le bon nombre.
    act(() => sync.setStatus({ devices: [pcDevice, iphone(4 * 3_600_000)] }));
    expect(await screen.findByText('L’iPhone ne s’est pas synchronisé depuis plus de 2 h : 1 rappel dans les 2 prochaines heures pourrait ne pas sonner à l’heure')).toBeInTheDocument();
  });
});
