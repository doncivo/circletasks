import { createHlcClock } from '../../../domain/hlc';
import type { AppleListSetting } from '../../../domain/appleReminders';
import type { Task } from '../../../domain/model';
import { asEntityId, type DeviceId, type LocalDate, type SpaceId, type TaskId } from '../../../domain/types';
import { openTestDb, type TestDb } from '../../../db/repositories/sql/testSetup';
import { createFakeReminders, type FakeReminders, type FakeRemindersOptions, type RemindersPlatform } from '../../../platform/reminders';
import { useAppStatusStore } from '../../app/appStatus';
import { useAppStore } from '../../app/appStore';
import { createAppContainer, type AppContainer } from '../../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../../app/navigation';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { runRemindersPass, type PassReport } from './remindersPass';
import { createSender } from './remindersWrites';

/**
 * Banc d'essai des Rappels Apple (K-05 à K-07) : base SQLite en mémoire, conteneur d'iPhone installé (`tauri`, `ios`), faux magasin
 * EventKit à l'horloge manuelle, espaces Pro et Perso. Aucun compte, aucun réseau.
 */
export const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
export const PERSO = '00000000-0000-4000-8000-000000000002' as SpaceId;
export const TODAY = '2026-10-08' as LocalDate;

export interface RemindersHarness {
  readonly db: TestDb;
  readonly container: AppContainer;
  readonly reminders: FakeReminders;
  /** Choisit une liste (affichée dans l'espace donné) dans le réglage partagé. */
  showList(list: { readonly id: string; readonly name?: string; readonly spaceId: SpaceId | null; readonly shown?: boolean }): Promise<void>;
  /**
   * Passage avec envoi vers Rappels (comme le coordinateur de l'app) ; `full` par défaut. Le coordinateur lance un `push` 6 s après l'écriture :
   * par défaut l'horloge avance de 5 s avant le passage (fenêtre d'annulation écoulée) ; `settle: false` teste la fenêtre elle-même.
   */
  pass(kind?: 'full' | 'push', options?: { readonly settle?: boolean }): Promise<PassReport>;
  tasks(): Promise<Task[]>;
  task(id: TaskId): Promise<Task | null>;
  taskByTitle(title: string): Promise<Task>;
  outbox(): Promise<{ table_name: string; row_id: string; field: string }[]>;
  conflicts(): Promise<{ field: string; kept_value: string; discarded_value: string; kept_device: string; discarded_device: string }[]>;
  close(): Promise<void>;
}

export interface HarnessOptions extends FakeRemindersOptions {
  readonly startAt?: string;
  /** Plateforme du conteneur ; défaut l'iPhone installé. */
  readonly runtime?: 'tauri' | 'web';
  readonly os?: 'ios' | 'windows' | 'other';
  /** Service de synchro injecté (déclencheur `sync`) ; absent : aucune synchro. */
  readonly sync?: AppContainer['sync'];
  /** Plateforme à la place du faux (PC : « indisponible »). */
  readonly reminders?: RemindersPlatform;
}

export async function setupRemindersHarness(suffix: string, options: HarnessOptions = {}): Promise<RemindersHarness> {
  const device = asEntityId<DeviceId>(`71000000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`);
  const db = await openTestDb(device, options.startAt ?? '2026-10-08T09:00:00.000Z');
  const reminders = createFakeReminders({ now: () => db.clock.nowMs(), ...options });
  reminders.addList({ id: 'L-courses', name: 'Courses', writable: true });
  reminders.addList({ id: 'L-travail', name: 'Travail', writable: true });
  const container = createAppContainer({
    clock: db.clock,
    hlc: createHlcClock({ clock: db.clock, deviceId: device }),
    data: db.data,
    reminders: options.reminders ?? reminders,
    sync: options.sync ?? null,
    platform: { runtime: options.runtime ?? 'tauri', os: options.os ?? 'ios' },
  });
  useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  useAppStore.getState().setTimeZone('Europe/Paris');
  return {
    db,
    container,
    reminders,
    async showList(list) {
      const state = appleRemindersState(container);
      await state.load();
      const current = appleRemindersStore.get(container).getState().lists.lists.filter((entry) => entry.id !== list.id);
      const entry: AppleListSetting = { id: list.id, name: list.name ?? list.id, spaceId: list.spaceId, shown: list.shown ?? list.spaceId !== null };
      await state.setLists({ lists: [...current, entry] });
    },
    pass: (kind = 'full', passOptions = {}) => {
      if (passOptions.settle !== false) db.clock.advance(5_000);
      return runRemindersPass(container, kind, { send: createSender(container) });
    },
    tasks: () => container.data.repos.tasks.listAppleSourced(),
    task: (id) => container.data.repos.tasks.getById(id, { includeDeleted: true }),
    async taskByTitle(title) {
      const rows = await db.driver.select<{ id: string }>('SELECT id FROM task WHERE title = ? ORDER BY created_at DESC LIMIT 1', [title]);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`tâche absente : ${title}`);
      return (await container.data.repos.tasks.getById(id as TaskId, { includeDeleted: true })) as Task;
    },
    outbox: () => db.driver.select('SELECT table_name, row_id, field FROM sync_outbox ORDER BY seq'),
    conflicts: () => db.driver.select('SELECT field, kept_value, discarded_value, kept_device, discarded_device FROM conflict_log ORDER BY id'),
    close: async () => {
      useAppStatusStore.setState({ sources: {} });
      useNavigationStore.setState(INITIAL_NAVIGATION);
      useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null, timeZone: null });
      await db.close();
    },
  };
}
