import { systemClock, type Clock } from '../../domain/clock';
import { createHlcClock, createWriteStamper, type WriteStamper } from '../../domain/hlc';
import { newEntityId, uuidGenerator, type IdGenerator } from '../../domain/id';
import type { DeviceId } from '../../domain/types';
import type { SqlDriver } from '../../db/driver';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
import { createDataAccess, createSqlRepositories, type RepositoryFactory } from '../../db/repositories';
import { detectOs, detectRuntime, openDesktopPlatform, type DesktopPlatform } from '../../platform';
import { openDatabase } from '../../platform/database';
import { useAppStore } from './appStore';
import { createAppContainer, type AppContainer } from './container';

let database: SqlDriver | undefined;

/**
 * Ouvre la base du runtime courant et applique les migrations. Appelé une fois au
 * démarrage ; l'état est publié dans le store (dbStatus).
 * La sauvegarde avant migration (beforeApply) sera branchée par data-model / desktop-tauri.
 */
export async function bootstrapDatabase(open: () => Promise<SqlDriver> = openDatabase): Promise<SqlDriver | undefined> {
  const { setDbStatus } = useAppStore.getState();
  setDbStatus('loading');
  try {
    const db = await open();
    await migrate(db, migrations);
    database = db;
    setDbStatus('ready');
    return db;
  } catch (error) {
    setDbStatus('error', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Base ouverte au démarrage. Réservé au démarrage et aux outils (sauvegarde) :
 * les features passent par `AppContainer.data`, jamais par cette fonction.
 */
export function getDatabase(): SqlDriver {
  if (!database) throw new Error('Base non initialisée : appeler bootstrapDatabase() au démarrage');
  return database;
}

export interface BootstrapAppOptions {
  readonly open?: () => Promise<SqlDriver>;
  /** Fabrique de repositories ; `createSqlRepositories` par défaut, remplaçable en test. */
  readonly repositories?: RepositoryFactory;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Intégration PC ; `openDesktopPlatform` par défaut (null hors Windows installé). */
  readonly desktop?: DesktopPlatform | null;
}

/** Tampon des lectures de démarrage : toute écriture à ce stade est une erreur de programmation. */
const readOnlyStamper: WriteStamper = {
  next: () => {
    throw new Error('Écriture impossible avant l’initialisation du générateur HLC');
  },
};

/**
 * Démarrage complet (ADR 0004, 0005) : base + migrations, identité de l'appareil,
 * graine HLC, accès aux données, conteneur. Renvoie undefined en cas d'échec
 * (dbStatus = 'error').
 *
 * À brancher dans App.tsx (à la place de bootstrapDatabase) dès que
 * `createSqlRepositories` existe ; le conteneur est alors fourni par AppContainerProvider.
 */
export async function bootstrapApp(options: BootstrapAppOptions = {}): Promise<AppContainer | undefined> {
  const driver = await bootstrapDatabase(options.open);
  if (!driver) return undefined;
  const factory = options.repositories ?? createSqlRepositories;
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidGenerator;
  try {
    const boot = factory(driver, readOnlyStamper);
    const storedDeviceId = await boot.settings.get('device.id');
    const deviceId = storedDeviceId ?? newEntityId<DeviceId>(ids);
    const hlc = createHlcClock({ clock, deviceId, seed: await boot.syncMeta.maxHlc() });
    const data = createDataAccess(driver, createWriteStamper(clock, hlc), factory);
    if (!storedDeviceId) await data.repos.settings.set('device.id', deviceId);
    return createAppContainer({
      clock,
      ids,
      hlc,
      data,
      platform: { runtime: detectRuntime(), os: detectOs() },
      desktop: options.desktop === undefined ? await openDesktopPlatform() : options.desktop,
    });
  } catch (error) {
    useAppStore.getState().setDbStatus('error', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
