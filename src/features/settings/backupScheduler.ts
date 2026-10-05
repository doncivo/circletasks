import type { AppContainer } from '../app/container';
import { backupStore } from './backupStore';

/** Période de sondage du minuteur : la décision (« le jour local a-t-il sa sauvegarde ? ») est prise par `runDaily`, pas par la période. */
export const BACKUP_POLL_INTERVAL_MS = 60_000;

export interface BackupSchedulerEnv {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface BackupScheduler {
  /** Première vérification terminée (ne rejette jamais). */
  readonly ready: Promise<void>;
  /** Sonde une fois, comme le ferait le minuteur ou un retour au premier plan (tests). */
  tick(): Promise<void>;
  dispose(): void;
}

/**
 * Planificateur de la sauvegarde quotidienne (P-04 critère 1) : à l'ouverture, au retour au premier plan ou de veille (`visibilitychange`,
 * `focus`) et toutes les minutes pendant que l'app tourne, donc à la première occasion après minuit. Rien en arrière-plan (fenêtre
 * masquée). Sans service de sauvegarde (iPhone, tests), ne fait rien. L'horloge est celle du conteneur (injectable).
 */
export function startBackupScheduler(container: AppContainer, env: BackupSchedulerEnv = { document, window }): BackupScheduler {
  if (!container.backups.available()) {
    return { ready: Promise.resolve(), tick: () => Promise.resolve(), dispose: () => undefined };
  }
  const store = backupStore.get(container);
  const setTimer = env.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearTimer = env.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let disposed = false;

  const tick = async (): Promise<void> => {
    if (disposed || env.document.visibilityState === 'hidden') return;
    await store.getState().runDaily();
  };
  const onResume = (): void => void tick();

  const timer = setTimer(onResume, BACKUP_POLL_INTERVAL_MS);
  env.document.addEventListener('visibilitychange', onResume);
  env.window.addEventListener('focus', onResume);
  const ready = tick();

  return {
    ready,
    tick,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      env.document.removeEventListener('visibilitychange', onResume);
      env.window.removeEventListener('focus', onResume);
    },
  };
}
