import { createManualClock, type ManualClock } from '../../src/domain/clock';
import { createHlcClock, createWriteStamper, type HlcClock } from '../../src/domain/hlc';
import type { Task } from '../../src/domain/model';
import type { DeviceId, LocalDate, SpaceId, TaskId } from '../../src/domain/types';
import type { SqlDriver } from '../../src/db/driver';
import { exportSqliteWasmImage, openSqliteWasmDriver } from '../../src/db/drivers/sqliteWasm';
import { migrations } from '../../src/db/migrations';
import { migrate } from '../../src/db/migrator';
import { createDataAccess, createSqlRepositories, type DataAccess } from '../../src/db/repositories';
import { createMemorySyncPlatform, type MemorySyncFolder, type MemorySyncPlatform } from '../../src/platform/sync/memory';
import type { RemoteChanges, SyncStatus } from '../../src/platform/sync/types';
import { createMemorySyncLogger, createSyncService, type SyncEngineService } from '../../src/sync';
import { createSimFolder, propagate, type PropagateOptions } from './syncCloudSim';

/**
 * Appareil simulé (ADR 0011, section 12) : sa base SQLite Wasm (migrations de l'app), son horloge contrôlée, son `HlcClock`, son coffre
 * et **son** dossier iCloud simulé, la plateforme mémoire `SyncPlatform` et le vrai service de synchro. Plusieurs appareils dans le même
 * processus échangent leurs dossiers par `syncCloudSim.propagate`.
 */

export const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
export const SCHEMA_VERSION = migrations.at(-1)?.version ?? 1;

export interface SimDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly driver: SqlDriver;
  readonly data: DataAccess;
  readonly clock: ManualClock;
  hlc: HlcClock;
  readonly folder: MemorySyncFolder;
  platform: MemorySyncPlatform;
  service: SyncEngineService;
  readonly logger: ReturnType<typeof createMemorySyncLogger>;
  readonly changes: RemoteChanges[];
  /** Un cycle complet ; renvoie l'état obtenu. */
  cycle(): Promise<SyncStatus>;
  /** Nouvelle instance de l'app sur la même base et le même dossier (redémarrage). */
  restart(): Promise<void>;
  createTask(title: string, extra?: Partial<Task>): Promise<Task>;
  updateTask(id: TaskId, patch: Parameters<DataAccess['repos']['tasks']['update']>[1]): Promise<Task>;
  deleteTask(id: TaskId): Promise<void>;
  task(id: TaskId): Promise<Task | null>;
  close(): Promise<void>;
}

let counter = 0;

/**
 * Base migrée construite une seule fois par processus de test : chaque appareil en reçoit une copie au lieu de rejouer les
 * 17 migrations (la moitié du coût d'un test à deux appareils).
 */
let migratedImage: Promise<Uint8Array> | null = null;
function migratedDatabaseImage(): Promise<Uint8Array> {
  migratedImage ??= (async () => {
    const template = await openSqliteWasmDriver();
    try {
      await migrate(template, migrations);
      return await exportSqliteWasmImage(template);
    } finally {
      await template.close();
    }
  })();
  return migratedImage;
}

export async function createSimDevice(id: string, options: { readonly name?: string; readonly start?: string; readonly clock?: ManualClock } = {}): Promise<SimDevice> {
  const driver = await openSqliteWasmDriver({}, await migratedDatabaseImage());
  const clock = options.clock ?? createManualClock(options.start ?? '2026-10-05T08:00:00.000Z');
  const deviceId = id as DeviceId;
  const folder = createSimFolder();
  const logger = createMemorySyncLogger();
  const changes: RemoteChanges[] = [];
  let hlc = createHlcClock({ clock, deviceId });
  const stamper = { next: () => createWriteStamper(clock, hlc).next() };
  const data = createDataAccess(driver, stamper, createSqlRepositories);
  await data.repos.settings.set('device.id', deviceId);

  const makePlatform = (): MemorySyncPlatform => createMemorySyncPlatform({ folder, nowMs: () => clock.nowMs() });
  const makeService = (platform: MemorySyncPlatform): SyncEngineService => {
    const service = createSyncService({ data, platform, hlc, clock, deviceId, sv: SCHEMA_VERSION, appVersion: '0.4.0', logger, setTimeout: () => 0, clearTimeout: () => undefined });
    service.onRemoteChanges((c) => changes.push(c));
    return service;
  };
  const platform = makePlatform();
  const device: SimDevice = {
    id: deviceId,
    name: options.name ?? id.slice(0, 4),
    driver,
    data,
    clock,
    hlc,
    folder,
    platform,
    service: makeService(platform),
    logger,
    changes,
    async cycle() {
      await device.service.syncNow('manual');
      return device.service.status();
    },
    async restart() {
      // Le dossier, le coffre et own.json survivent (Rust) ; l'horloge locale repart de la base (graine, ADR 0005).
      hlc = createHlcClock({ clock, deviceId, seed: await data.repos.syncMeta.maxHlc() });
      device.hlc = hlc;
      device.service = makeService(device.platform);
    },
    async createTask(title, extra = {}) {
      counter += 1;
      const taskId = (extra.id ?? `${String(counter).padStart(8, '0')}-0000-4000-8000-${String(deviceId).slice(24)}`) as TaskId;
      return data.repos.tasks.create({
        id: taskId,
        spaceId: PRO,
        projectId: null,
        title,
        note: '',
        date: '2026-10-05' as LocalDate,
        time: null,
        status: 'todo',
        doneAt: null,
        sortOrder: counter,
        carriedOver: false,
        recurrenceId: null,
        seriesIndex: null,
        seriesTemplate: null,
        goalId: null,
        icon: null,
        someday: false,
        source: 'local',
        externalId: null,
        externalEventId: null,
        ...extra,
      });
    },
    updateTask: (taskId, patch) => data.repos.tasks.update(taskId, patch),
    async deleteTask(taskId) {
      await data.repos.tasks.softDelete([taskId]);
    },
    async task(taskId) {
      return (await data.repos.tasks.getById(taskId, { includeDeleted: true })) ?? null;
    },
    close: () => driver.close(),
  };
  return device;
}

/** Premier appareil : choisit son dossier et crée la clé. */
export async function setupFirst(device: SimDevice): Promise<void> {
  await device.platform.folder.choose();
  await device.platform.key.create();
}

/**
 * Associe `joiner` au dossier de `owner` (clé de secours saisie dans la fenêtre `pairing`) ; le dossier de `owner` est d'abord recopié.
 */
export async function pair(owner: SimDevice, joiner: SimDevice): Promise<void> {
  propagate(owner.folder, joiner.folder, owner.id);
  await joiner.platform.folder.choose();
  await owner.platform.key.openPairing('show');
  const payload = await owner.platform.key.pairingPayload();
  await owner.platform.key.closePairing();
  await joiner.platform.key.openPairing('import');
  await joiner.platform.key.import({ recoveryKey: payload.recoveryKey });
}

/** Recopie mutuelle des dossiers de tous les appareils (iCloud à jour partout). */
export function syncFolders(devices: readonly SimDevice[], options: PropagateOptions = {}): void {
  for (const from of devices) for (const to of devices) if (from !== to) propagate(from.folder, to.folder, from.id, options);
}

/** Valeurs des tâches (titre, note, état, suppression) d'un appareil, triées : comparaison de convergence. */
export async function taskSnapshot(device: SimDevice): Promise<unknown[]> {
  return device.driver.select('SELECT id, title, note, status, date, deleted_at IS NOT NULL AS deleted FROM task ORDER BY id');
}
