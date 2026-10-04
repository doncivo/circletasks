import { createStore } from 'zustand';
import { backupDay, backupStamp, isDailyBackupDue, sortBackupVersions } from '../../domain/backupSchedule';
import { backupFailureOf, type BackupFailureReason, type BackupVersion } from '../../platform/backup';
import { logDesktopFailure } from '../../platform';
import { defineFeatureStore, type AppContainer } from '../app/container';

export type BackupListStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Phase de la restauration : choix, restauration en cours, terminée (redémarrage annoncé), échec. */
export type RestorePhase = 'idle' | 'running' | 'done' | 'failed';

export interface BackupState {
  readonly status: BackupListStatus;
  readonly versions: readonly BackupVersion[];
  readonly directory: string | null;
  /** Dernière sauvegarde (automatique ou « Sauvegarder maintenant ») échouée : ligne rouge de Réglages. */
  readonly failed: boolean;
  readonly backingUp: boolean;
  /** Message bref après « Sauvegarder maintenant ». */
  readonly justBackedUp: boolean;
  readonly restorePhase: RestorePhase;
  readonly restoreError: BackupFailureReason | null;
  /** La base est fermée (échec après la fermeture) : seul un redémarrage rouvre l'app. */
  readonly restartNeeded: boolean;
  /** Lit les versions. Ne rejette jamais. */
  load(): Promise<void>;
  /**
   * Sauvegarde quotidienne si le jour local n'a pas encore la sienne (ouverture, retour de veille, minuit passé). Ne rejette jamais et
   * ne fait rien sans service de sauvegarde ou si le jour est déjà couvert.
   */
  runDaily(): Promise<void>;
  /** « Sauvegarder maintenant » : remplace la version du jour. Ne rejette jamais. */
  backupNow(): Promise<void>;
  /** Restaure une version (la confirmation est faite par l'écran), puis relance l'app après l'annonce. Ne rejette jamais. */
  restore(version: BackupVersion): Promise<void>;
  /** Relance l'app (rouvre la base). Ne rejette jamais. */
  restart(): Promise<void>;
  resetRestore(): void;
}

/** Délai entre l'annonce « Restauration terminée, redémarrage » et le redémarrage effectif. */
export const RESTART_ANNOUNCE_MS = 1200;

export const backupStore = defineFeatureStore<BackupState>((container: AppContainer) => createBackupStore(container));

function createBackupStore(container: AppContainer) {
  const service = container.backups;
  // Dernier jour pour lequel la sauvegarde quotidienne est assurée : évite de relire la liste à chaque sondage.
  let coveredDay: string | null = null;
  let dailyInFlight: Promise<void> | null = null;

  return createStore<BackupState>()((set, get) => {
    async function refresh(): Promise<void> {
      const listing = await service.list();
      set({ versions: sortBackupVersions(listing.versions), directory: listing.directory, status: 'ready' });
    }

    return {
      status: 'idle',
      versions: [],
      directory: null,
      failed: false,
      backingUp: false,
      justBackedUp: false,
      restorePhase: 'idle',
      restoreError: null,
      restartNeeded: false,
      async load() {
        if (!service.available()) return;
        set({ status: get().status === 'ready' ? 'ready' : 'loading' });
        try {
          await refresh();
        } catch (error) {
          logDesktopFailure('backup-list', error);
          set({ status: 'error' });
        }
      },
      runDaily() {
        if (!service.available()) return Promise.resolve();
        const today = backupDay(container.clock);
        if (coveredDay === today) return Promise.resolve();
        // Un seul passage à la fois : l'ouverture, le retour au premier plan et le minuteur peuvent se chevaucher.
        dailyInFlight ??= (async () => {
          try {
            const listing = await service.list();
            if (isDailyBackupDue(listing.versions, container.clock)) {
              await service.createDaily({ day: today, replace: false });
            }
            coveredDay = today;
            set({ failed: false });
            await refresh();
          } catch (error) {
            // Consignée (journal technique) et affichée en rouge dans Réglages ; nouvelle tentative à la prochaine occasion.
            logDesktopFailure('backup-daily', error);
            set({ failed: true });
          } finally {
            dailyInFlight = null;
          }
        })();
        return dailyInFlight;
      },
      async backupNow() {
        if (!service.available() || get().backingUp) return;
        set({ backingUp: true, justBackedUp: false });
        try {
          await service.createDaily({ day: backupDay(container.clock), replace: true });
          coveredDay = backupDay(container.clock);
          set({ failed: false, justBackedUp: true });
          await refresh();
        } catch (error) {
          logDesktopFailure('backup-now', error);
          set({ failed: true, justBackedUp: false });
        } finally {
          set({ backingUp: false });
        }
      },
      async restore(version) {
        if (!service.available() || get().restorePhase === 'running') return;
        set({ restorePhase: 'running', restoreError: null, restartNeeded: false });
        try {
          await service.restore({ name: version.name, stamp: backupStamp(container.clock) });
        } catch (error) {
          logDesktopFailure('backup-restore', error);
          const { reason, databaseClosed } = backupFailureOf(error);
          set({ restorePhase: 'failed', restoreError: reason, restartNeeded: databaseClosed });
          return;
        }
        set({ restorePhase: 'done' });
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, RESTART_ANNOUNCE_MS));
        await get().restart();
      },
      async restart() {
        try {
          await service.restart();
        } catch (error) {
          logDesktopFailure('backup-restart', error);
        }
      },
      resetRestore: () => set({ restorePhase: 'idle', restoreError: null, restartNeeded: false }),
    };
  });
}
