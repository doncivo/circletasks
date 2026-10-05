import { startSyncScheduler, type SyncSchedulerEnv } from '../../sync';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { applyRemoteChanges } from './remoteChanges';

export interface SyncIntegration {
  dispose(): void;
}

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
  return {
    dispose: () => {
      scheduler.dispose();
      stopStatus();
      stopChanges();
      useAppStatusStore.getState().setStatus('syncing', null);
      useAppStatusStore.getState().setStatus('waitingIcloud', null);
    },
  };
}
