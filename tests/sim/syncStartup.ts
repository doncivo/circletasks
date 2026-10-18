import { uuidGenerator } from '../../src/domain/id';
import type { NewRecurrence, Task } from '../../src/domain/model';
import { reminderFireAt } from '../../src/domain/recurrenceNext';
import type { LocalDate, RecurrenceId, ReminderId } from '../../src/domain/types';
import { createAppContainer, type AppContainer } from '../../src/features/app/container';
import { startAppStartup, type AppStartup, type StartupEnv } from '../../src/features/app/startup';
import { startSyncIntegration, type SyncIntegration } from '../../src/features/sync/startSync';
import type { SimDevice } from './syncDevice';

/**
 * T-TECH-01 : récurrences et démarrage sur appareil simulé. Complète `syncDevice.ts` (qui n'a aucune récurrence) sans en changer le
 * comportement : création d'une tâche récurrente avec ses rappels, et démarrage de l'app dans l'ordre réel de `App.tsx`
 * (`startAppStartup`, attente de `ready`, puis `startSyncIntegration`), avec le vrai service de synchro de l'appareil.
 */

const DAILY = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } as const;

export interface RecurringSeed {
  readonly recurrenceId: RecurrenceId;
  readonly task: Task;
}

/** Récurrence quotidienne et son occurrence 0 (date, heure et avances de rappel au choix ; les rappels exigent une heure). */
export async function createRecurringTask(
  device: SimDevice,
  title: string,
  options: { readonly date: LocalDate; readonly time?: string; readonly offsets?: readonly number[] },
): Promise<RecurringSeed> {
  const recurrenceId = uuidGenerator.next() as RecurrenceId;
  const rule: NewRecurrence = { id: recurrenceId, ...DAILY };
  await device.data.repos.recurrences.create(rule);
  const time = options.time ?? null;
  const task = await device.createTask(title, { recurrenceId, seriesIndex: 0, date: options.date, time: time as Task['time'] });
  if (time !== null && (options.offsets ?? []).length > 0) {
    await device.data.repos.reminders.replaceForTarget(
      { type: 'task', id: task.id },
      (options.offsets ?? []).map((offsetMin) => ({
        id: uuidGenerator.next() as ReminderId,
        targetType: 'task' as const,
        targetId: task.id,
        offsetMin: offsetMin as never,
        fireAt: reminderFireAt(options.date, time, offsetMin),
      })),
    );
  }
  return { recurrenceId, task };
}

export interface BootedDevice {
  readonly container: AppContainer;
  readonly startup: AppStartup;
  readonly integration: SyncIntegration;
  /** Premier contrôle de report terminé et dernier cycle de synchro conclu (aucun délai : attente des promesses du démarrage). */
  settled(): Promise<void>;
  dispose(): void;
}

const noop = (): void => undefined;

/** Démarre l'app sur `device` comme `App.tsx` : conteneur, `startAppStartup`, `ready`, puis intégration de la synchro. */
export async function bootDevice(device: SimDevice): Promise<BootedDevice> {
  const container = createAppContainer({ clock: device.clock, hlc: device.hlc, data: device.data, sync: device.service, syncPlatform: device.platform });
  const document = { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' as DocumentVisibilityState };
  const env = { document, window: { addEventListener: noop, removeEventListener: noop }, timers: { setInterval: () => 0, clearInterval: noop } } as unknown as StartupEnv;
  const startup = startAppStartup(container, env);
  await startup.ready;
  const integration = startSyncIntegration(container, { document, clock: device.clock, setInterval: () => 0, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop });
  return {
    container,
    startup,
    integration,
    async settled() {
      await startup.ready;
      for (let cycle = device.service.running(); cycle !== null; cycle = device.service.running()) await cycle;
      await integration.refreshed();
    },
    dispose() {
      integration.dispose();
      startup.dispose();
    },
  };
}
