import { QUIT_HANDLER_SYNC_MS } from '../../domain/sync/limits';
import { startSyncScheduler, type SyncScheduler, type SyncSchedulerEnv } from '../../sync';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { applyRemoteChanges } from './remoteChanges';

export interface SyncIntegration {
  dispose(): void;
}

/** Planificateur actif de chaque conteneur : « Quitter » (desktop.ts) passe par lui, jamais par un minuteur à part. */
const schedulers = new WeakMap<AppContainer, SyncScheduler>();

/**
 * Branche la synchro sur l'app (Y-02 critères 1, 17 et 18) : planificateur (ouverture, 5 min fenêtre visible, masquage), bandeaux A-09
 * (« Synchro en cours », « En attente d'iCloud » ; « Hors ligne » n'est jamais retiré ici) et rechargement des stores après chaque lot
 * reçu. Sans synchro (`container.sync` null) : rien, aucun coût.
 */
export function startSyncIntegration(container: AppContainer, env: Partial<SyncSchedulerEnv> = {}): SyncIntegration {
  const sync = container.sync;
  if (!sync) return { dispose: () => undefined };
  const status = useAppStatusStore.getState();
  const applyBanners = (): void => {
    const phase = sync.status().phase;
    status.setStatus('syncing', phase === 'syncing' ? {} : null);
    status.setStatus('waitingIcloud', phase === 'waiting-icloud' ? {} : null);
  };
  const stopStatus = sync.subscribe(applyBanners);
  const stopChanges = sync.onRemoteChanges((change) => void applyRemoteChanges(container, change).catch(() => undefined));
  const scheduler = startSyncScheduler(sync, { document: env.document ?? document, clock: env.clock ?? container.clock, ...(env.setInterval ? { setInterval: env.setInterval } : {}), ...(env.clearInterval ? { clearInterval: env.clearInterval } : {}) });
  schedulers.set(container, scheduler);
  return {
    dispose: () => {
      if (schedulers.get(container) === scheduler) schedulers.delete(container);
      scheduler.dispose();
      stopStatus();
      stopChanges();
      useAppStatusStore.getState().setStatus('syncing', null);
      useAppStatusStore.getState().setStatus('waitingIcloud', null);
    },
  };
}

/**
 * « Quitter » (Y-02 critère 1) : dernier cycle par le planificateur (`beforeQuit`, qui annule son minuteur dès que le cycle finit),
 * 4,5 s au plus (Rust sort à 5 s). Sans synchro branchée : rien. Ne rejette jamais.
 */
export function syncBeforeQuit(container: AppContainer): Promise<void> {
  return schedulers.get(container)?.beforeQuit(QUIT_HANDLER_SYNC_MS) ?? Promise.resolve();
}
