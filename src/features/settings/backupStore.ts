import { createStore } from 'zustand';
import { backupDay, backupStamp, isDailyBackupDue, sortBackupVersions } from '../../domain/backupSchedule';
import type { BackupFailureReason, BackupVersion } from '../../platform/backup';
import type { RestoreFlowOutcome } from './restoreFlow';
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
  /** Marqueur de restauration non écrit (P-04-iOS critère 12) : code affiché avec « Voir la synchronisation » avant le redémarrage. */
  readonly markerFailure: string | null;
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
  let failures = 0;
  let nextRetryAt = 0;
  let failureLoggedDay: string | null = null;

  return createStore<BackupState>()((set, get) => {
    const isRestoring = (): boolean => get().restorePhase === 'running' || get().restorePhase === 'done';

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
      markerFailure: null,
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
        // Jamais pendant une restauration (base fermée ou fichier remplacé) : ni sauvegarde, ni lecture de la liste.
        if (!service.available() || isRestoring()) return Promise.resolve();
        const today = backupDay(container.clock);
        if (coveredDay === today) return Promise.resolve();
        // Échec persistant : nouvelle tentative après un délai croissant (1 min, 2 min… 1 h au plus), pas à chaque sondage.
        if (container.clock.nowMs() < nextRetryAt) return Promise.resolve();
        // Un seul passage à la fois : l'ouverture, le retour au premier plan et le minuteur peuvent se chevaucher.
        dailyInFlight ??= (async () => {
          try {
            const listing = await service.list();
            if (isDailyBackupDue(listing.versions, container.clock)) {
              await service.createDaily({ day: today, replace: false });
            }
            coveredDay = today;
            failures = 0;
            nextRetryAt = 0;
            set({ failed: false });
            await refresh();
          } catch (error) {
            // Affichée en rouge dans Réglages ; consignée au premier échec du jour seulement (pas un message par minute).
            failures += 1;
            nextRetryAt = container.clock.nowMs() + Math.min(60_000 * 2 ** (failures - 1), 3_600_000);
            if (failureLoggedDay !== today) {
              failureLoggedDay = today;
              logDesktopFailure('backup-daily', error);
            }
            set({ failed: true });
          } finally {
            dailyInFlight = null;
          }
        })();
        return dailyInFlight;
      },
      async backupNow() {
        if (!service.available() || get().backingUp || isRestoring()) return;
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
        set({ restorePhase: 'running', restoreError: null, restartNeeded: false, markerFailure: null });
        // Une sauvegarde automatique déjà en cours se termine avant que la base ne soit fermée.
        await dailyInFlight;
        let outcome: RestoreFlowOutcome;
        try {
          // Ordre et mémo : `restoreFlow.ts`, chargé à la demande (bundle de départ).
          const { performRestore } = await import('./restoreFlow');
          outcome = await performRestore(container, service, version, backupStamp(container.clock));
        } catch (error) {
          logDesktopFailure('backup-restore', error);
          set({ restorePhase: 'failed', restoreError: 'io', restartNeeded: false });
          return;
        }
        if (outcome.kind === 'failed') {
          set({ restorePhase: 'failed', restoreError: outcome.reason, restartNeeded: outcome.databaseClosed });
          return;
        }
        set({ restorePhase: 'done', markerFailure: outcome.markerFailure });
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
      resetRestore: () => set({ restorePhase: 'idle', restoreError: null, restartNeeded: false, markerFailure: null }),
    };
  });
}
