import { nowIso, systemClock, type Clock } from '../../domain/clock';
import { createHlcClock, createWriteStamper, type WriteStamper } from '../../domain/hlc';
import { newEntityId, uuidGenerator, type IdGenerator } from '../../domain/id';
import type { DeviceId } from '../../domain/types';
import type { SqlDriver } from '../../db/driver';
import { createBackupBeforeMigration, MigrationBackupError, type MigrationBackup } from '../../db/migrationBackup';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
import { createDataAccess, createSqlRepositories, reintegrateUnknownFields, type ReintegrationReport, type RepositoryFactory } from '../../db/repositories';
import { detectOs, detectRuntime, openDesktopPlatform, type DesktopPlatform } from '../../platform';
import { openBackupService, type BackupService } from '../../platform/backup';
import { openFileService, type FileService } from '../../platform/files';
import { openFocusEndScheduler, openFocusWindowPlatform, type FocusEndScheduler, type FocusWindowPlatform } from '../../platform/focus';
import { createLedgerStore, openNotificationActionSource, openNotificationScheduler, systemNotificationClock, type NotificationActionSource, type NotificationClock, type NotificationScheduler } from '../../platform/notifications';
import { composeFocusEndText } from '../reminders/focusEndText';
import { createSettingsLedger } from '../reminders/settingsLedger';
import { openCalendarPlatform, PRODUCTION_ENDPOINTS, simulatorEndpoints, type CalendarPlatform } from '../../platform/calendars';
import { createMigrationBackup, openDatabase } from '../../platform/database';
import { logFailure } from '../../platform/desktop/log';
import { openSyncPlatform } from '../../platform/sync';
import type { SyncPlatform } from '../../platform/sync/types';
import { createSyncService } from '../../sync';
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
    await migrate(db, migrations, { beforeApply: createBackupBeforeMigration(port, options.clock), afterApply: (db) => reintegrateAfterMigration(db, options.clock).then(() => undefined) });
    setDbStatus('ready');
    return db;
  } catch (error) {
    if (db) await db.close().catch(() => undefined);
    setDbStatus('error', { detail: error instanceof Error ? error.message : String(error), backupFailed: error instanceof MigrationBackupError });
    return undefined;
  }
}

/**
 * Y-07 critère 6 (décision D3) : à la fin de `migrate()`, à chaque démarrage, les champs de synchro gardés dans `sync_unknown` et devenus
 * connus (mise à jour de l'app) sont réintégrés sous garde. Un échec n'empêche jamais le démarrage : la page en cours est annulée (garde
 * comprise), les champs restent et sont retentés au démarrage suivant ; le journal ne porte que le nom de l'erreur, jamais une valeur.
 */
export async function reintegrateAfterMigration(db: SqlDriver, clock: Clock = systemClock): Promise<ReintegrationReport | null> {
  try {
    return await reintegrateUnknownFields(db, {
      now: nowIso(clock),
      onRowError: (name) => logFailure('sync', `réintégration d'une ligne impossible, elle reste pour le démarrage suivant (${name})`),
    });
  } catch (error) {
    logFailure('sync', `réintégration des champs inconnus impossible (${error instanceof Error ? error.name : 'erreur'})`);
    return null;
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
  /** Mini-fenêtre Focus (F-01) ; `openFocusWindowPlatform` par défaut (null hors Windows installé). */
  readonly focusWindow?: FocusWindowPlatform | null;
  /** Notifications locales de rappel (N-01) ; `openNotificationScheduler` par défaut (adaptateur réel sur l'iPhone installé, vide ailleurs). */
  readonly notifications?: NotificationScheduler;
  /** Notification de fin de session Focus (F-04) ; `openFocusEndScheduler` par défaut. */
  readonly focusEndScheduler?: FocusEndScheduler;
  /** Instant et fuseau de la planification des rappels ; l'horloge du système par défaut. */
  readonly notificationClock?: NotificationClock;
  /** Source des actions de notification (tests, e2e) ; sinon le plugin Swift sur l'iPhone installé, aucune ailleurs. */
  readonly notificationActions?: NotificationActionSource | null;
  /** Enregistrement de fichiers (H-03) ; `openFileService` par défaut. */
  readonly files?: FileService;
  /** Sauvegardes locales (P-04) ; `openBackupService` par défaut. */
  readonly backups?: BackupService;
  /** Voir BootstrapDatabaseOptions.backup. */
  readonly backup?: BootstrapDatabaseOptions['backup'];
  /**
   * Plateforme de synchro (ADR 0011) ; `openSyncPlatform` par défaut (commandes Rust `sync_*` du lot Y1 dans l'app, mémoire dans le
   * navigateur de développement) ; null, ou une plateforme indisponible (iPhone jusqu'à l'ordre 5) : pas de synchro, aucun coût.
   */
  readonly syncPlatform?: SyncPlatform | null;
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
    // ADR 0011 section 3.2 (audit M10) : la garde de la synchro est vide au démarrage, y compris après une restauration P-04 (qui relance
    // l'app). Une ligne trouvée (base copiée à chaud) est supprimée et journalisée.
    const strayGuards = await Promise.resolve()
      .then(() => data.repos.sync.assertGuardEmpty())
      .catch(() => 0);
    if (strayGuards > 0) logFailure('sync', `garde trouvée au démarrage : ${String(strayGuards)}`);
    // N-01 : registre local partagé entre les rappels et la fin de Focus (réglage local, sur la base BRUTE : jamais observée).
    const notificationLedger = createLedgerStore(createSettingsLedger(data.repos.settings));
    const notificationClock = options.notificationClock ?? systemNotificationClock;
    const runtime = detectRuntime();
    const os = detectOs();
    const desktop = options.desktop === undefined ? await openDesktopPlatform() : options.desktop;
    const opened = options.syncPlatform === undefined ? openSyncPlatform(detectRuntime(), detectOs()) : options.syncPlatform;
    const syncPlatform = opened?.available() ? opened : null;
    const sync = syncPlatform
      ? createSyncService({
          data,
          platform: syncPlatform,
          hlc,
          clock,
          deviceId,
          devicePlatform: detectOs() === 'ios' ? 'ios' : 'windows',
          appVersion: desktop ? await desktop.getVersion().catch(() => '0.0.0') : '0.0.0',
          sv: migrations.at(-1)?.version ?? 1,
        })
      : null;
    return createAppContainer({
      clock,
      ids,
      hlc,
      data,
      platform: { runtime: detectRuntime(), os: detectOs() },
      desktop,
      sync,
      syncPlatform,
      notificationLedger,
      notificationClock,
      notificationActions: options.notificationActions === undefined ? openNotificationActionSource(runtime, os) : options.notificationActions,
      notifications: options.notifications ?? openNotificationScheduler(runtime, os, { ledger: notificationLedger, clock: notificationClock, log: (code, counts) => logFailure('notifications', `${code} ${JSON.stringify(counts ?? {})}`) }),
      focusEndScheduler: options.focusEndScheduler ?? openFocusEndScheduler(runtime, os, { ledger: notificationLedger, clock: notificationClock, compose: composeFocusEndText }),
      focusWindow: options.focusWindow === undefined ? await openFocusWindowPlatform() : options.focusWindow,
      files: options.files ?? openFileService(detectRuntime(), detectOs()),
      backups: options.backups ?? openBackupService(detectRuntime(), detectOs(), { db: driver }),
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
