import { createHlcClock } from '../../domain/hlc';
import type { Task } from '../../domain/model';
import { asEntityId, type DeviceId, type LocalTime, type ReminderId, type SpaceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { createFakeNotificationScheduler, createLedgerStore, createUnavailableNotificationScheduler, type FakeNotificationScheduler, type NotificationScheduler } from '../../platform/notifications';
import { createFakeBridge, createMemoryLedger, type FakeBridge, type MemoryLedger } from '../../platform/notifications/fakeBridge';
import { createTauriNotificationScheduler } from '../../platform/notifications/tauriNotifications';
import { createAppContainer, type AppContainer, type AppContainerParts } from '../app/container';
import { useAppStatusStore } from '../app/appStatus';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { createSettingsLedger } from './settingsLedger';

/** Aides des tests des rappels (N-01, N-05, N-06, N-07, N-04) : base en mémoire, horloge manuelle, planificateur faux ou adaptateur réel sur un faux pont. */
export const NOW_ISO = '2026-10-08T08:00:00.000Z'; // 10:00 à Paris (UTC+2)

export interface ReminderHarness {
  readonly db: TestDb;
  readonly container: AppContainer;
  readonly zone: { name: string | null };
  /** Faux planificateur (mode « faux »). */
  readonly fake: FakeNotificationScheduler;
  /** Faux pont et registre mémoire (mode « adaptateur réel »). */
  readonly bridge: FakeBridge;
  /** Réglage `notifications.ledger` réel de la base (mode « adaptateur réel »). */
  readonly ledger: MemoryLedger;
}

export interface SetupOptions {
  /** `fake` : planificateur faux ; `real` : adaptateur réel sur un faux pont ; `none` : implémentation vide (PC). */
  readonly mode?: 'fake' | 'real' | 'none';
  readonly platform?: AppContainer['platform'];
  readonly parts?: Partial<AppContainerParts>;
  readonly startAt?: string;
  readonly zone?: string | null;
}

let counter = 0;

export async function setupReminders(options: SetupOptions = {}): Promise<ReminderHarness> {
  counter += 1;
  const device = asEntityId<DeviceId>(`70000000-0000-4000-8000-${String(counter).padStart(12, '0')}`);
  const db = await openTestDb(device, options.startAt ?? NOW_ISO);
  const zone = { name: options.zone === undefined ? 'Europe/Paris' : options.zone };
  const fake = createFakeNotificationScheduler();
  const bridge = createFakeBridge();
  const ledger = createMemoryLedger();
  const mode = options.mode ?? 'fake';
  const container = makeContainer(db, device, zone, mode, fake, bridge, options);
  useAppStatusStore.setState({ sources: {} });
  return { db, container, zone, fake, bridge, ledger };
}

function makeContainer(
  db: TestDb,
  device: DeviceId,
  zone: { name: string | null },
  mode: 'fake' | 'real' | 'none',
  fake: FakeNotificationScheduler,
  bridge: FakeBridge,
  options: SetupOptions,
  settingsLedger = createLedgerStore(createSettingsLedger(db.data.repos.settings)),
): AppContainer {
  const notificationClock = { nowMs: () => db.clock.nowMs(), zone: () => zone.name };
  const notifications: NotificationScheduler =
    mode === 'fake' ? fake : mode === 'real' ? createTauriNotificationScheduler({ bridge, ledger: settingsLedger, clock: notificationClock }) : createUnavailableNotificationScheduler();
  return createAppContainer({
    clock: db.clock,
    hlc: createHlcClock({ clock: db.clock, deviceId: device }),
    data: db.data,
    platform: options.platform ?? { runtime: 'tauri', os: 'ios' },
    notifications,
    notificationLedger: settingsLedger,
    notificationClock,
    ...options.parts,
  });
}

/**
 * Une app « redémarrée » : mêmes données, mêmes faux (l'iPhone garde ses notifications), instances neuves de tout le reste
 * (conteneur, magasins, coordinateur, adaptateur : la mémoire du processus est perdue).
 */
export function reopenReminders(harness: ReminderHarness, options: SetupOptions = {}): AppContainer {
  return makeContainer(harness.db, harness.db.deviceId, harness.zone, options.mode ?? 'fake', harness.fake, harness.bridge, options);
}

export async function seedReminderTask(
  container: AppContainer,
  over: { title?: string; spaceId?: SpaceId; date: string; time: string | null; offsets?: readonly number[] },
): Promise<Task> {
  const created = await createTaskUseCases(container).create({
    title: over.title ?? 'Appeler le médecin',
    spaceId: over.spaceId ?? SPACE_PERSO_ID,
    date: over.date as never,
    ...(over.time === null ? {} : { time: over.time as LocalTime }),
    reminderOffsets: (over.offsets ?? [0]) as never,
  });
  if (!created.ok) throw new Error(`création impossible : ${created.error}`);
  return created.value;
}

export type { ReminderId };
