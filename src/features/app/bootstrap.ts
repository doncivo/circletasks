import { systemClock, type Clock } from '../../domain/clock';
import { createHlcClock, createWriteStamper, type WriteStamper } from '../../domain/hlc';
import { newEntityId, uuidGenerator, type IdGenerator } from '../../domain/id';
import type { DeviceId } from '../../domain/types';
import type { SqlDriver } from '../../db/driver';
import { createBackupBeforeMigration, MigrationBackupError, type MigrationBackup } from '../../db/migrationBackup';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
import { createDataAccess, createSqlRepositories, type RepositoryFactory } from '../../db/repositories';
import { detectOs, detectRuntime, openDesktopPlatform, type DesktopPlatform } from '../../platform';
import { openCalendarPlatform, PRODUCTION_ENDPOINTS, simulatorEndpoints, type CalendarPlatform } from '../../platform/calendars';
import { createMigrationBackup, openDatabase } from '../../platform/database';
import { useAppStore } from './appStore';
import { createAppContainer, type AppContainer } from './container';

/**
 * Ouvre la base du runtime courant et applique les migrations. Appelé une fois au
 * démarrage ; l'état est publié dans le store (dbStatus).
 * Avant toute migration en attente sur une base existante, une sauvegarde est faite (D-03) ;
 * si elle échoue, rien n’est migré et dbStatus passe à « error » avec dbBackupFailed.
 */
export interface BootstrapDatabaseOptions {
  readonly clock?: Clock | undefined;
  /** Port de sauvegarde avant migration ; celui de la plateforme par défaut (aucun en navigateur de dev). */
  readonly backup?: ((db: SqlDriver) => Promise<MigrationBackup | undefined>) | undefined;
}

export async function bootstrapDatabase(
  open: () => Promise<SqlDriver> = openDatabase,
  options: BootstrapDatabaseOptions = {},
): Promise<SqlDriver | undefined> {
  const { setDbStatus } = useAppStore.getState();
  setDbStatus('loading');
  let db: SqlDriver | undefined;
  try {
    db = await open();
    const port = await (options.backup ?? createMigrationBackup)(db);
    await migrate(db, migrations, { beforeApply: createBackupBeforeMigration(port, options.clock) });
    setDbStatus('ready');
    return db;
  } catch (error) {
    if (db) await db.close().catch(() => undefined);
    setDbStatus('error', { detail: error instanceof Error ? error.message : String(error), backupFailed: error instanceof MigrationBackupError });
    return undefined;
  }
}

export interface BootstrapAppOptions {
  readonly open?: () => Promise<SqlDriver>;
  /** Fabrique de repositories ; `createSqlRepositories` par défaut, remplaçable en test. */
  readonly repositories?: RepositoryFactory;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Intégration PC ; `openDesktopPlatform` par défaut (null hors Windows installé). */
  readonly desktop?: DesktopPlatform | null;
  /** Agendas externes ; `openCalendarPlatform` par défaut (commandes Rust, ou mémoire + simulateurs en développement). */
  readonly calendars?: CalendarPlatform;
  /** Voir BootstrapDatabaseOptions.backup. */
  readonly backup?: BootstrapDatabaseOptions['backup'];
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
 * (dbStatus = 'error'). Appelé par App.tsx ; le conteneur est fourni par AppContainerProvider.
 */
export async function bootstrapApp(options: BootstrapAppOptions = {}): Promise<AppContainer | undefined> {
  const driver = await bootstrapDatabase(options.open, { clock: options.clock, backup: options.backup });
  if (!driver) return undefined;
  const factory = options.repositories ?? createSqlRepositories;
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? uuidGenerator;
  try {
    // Prises de test des e2e : chargées dynamiquement et seulement en développement (Vite retire la branche d'un build).
    if (import.meta.env.DEV) (await import('../../db/testHooks')).installDevTestHooks(driver);
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
      calendars: options.calendars ?? (await openCalendarPlatform(...developmentCalendarSetup())),
    });
  } catch (error) {
    useAppStore.getState().setDbStatus('error', { detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * Points d'accès et ID client des simulateurs d'agendas, en développement seulement (variables VITE_CT_GOOGLE_SIM, VITE_CT_CALDAV_SIM,
 * VITE_CT_GOOGLE_SIM_CLIENT_ID posées par Playwright) : un build de production n'en lit jamais.
 */
function developmentCalendarSetup(): [CalendarEndpointsArg, undefined, { googleClientId?: string }] {
  const env = import.meta.env;
  if (!env.DEV) return [PRODUCTION_ENDPOINTS, undefined, {}];
  // Playwright : un test qui modifie l'état d'un simulateur en démarre un à lui et l'annonce avant le chargement de la page.
  const override = (globalThis as { __ctCalendarSims?: { google: string; caldav: string; clientId?: string } }).__ctCalendarSims;
  if (override) return [simulatorEndpoints(override.google, override.caldav), undefined, override.clientId ? { googleClientId: override.clientId } : {}];
  if (!env.VITE_CT_GOOGLE_SIM || !env.VITE_CT_CALDAV_SIM) return [PRODUCTION_ENDPOINTS, undefined, {}];
  return [simulatorEndpoints(env.VITE_CT_GOOGLE_SIM, env.VITE_CT_CALDAV_SIM), undefined, env.VITE_CT_GOOGLE_SIM_CLIENT_ID ? { googleClientId: env.VITE_CT_GOOGLE_SIM_CLIENT_ID } : {}];
}

type CalendarEndpointsArg = Parameters<typeof openCalendarPlatform>[0];
