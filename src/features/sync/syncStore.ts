import { createStore } from 'zustand';
import type { RestoreOption } from '../../domain/sync/epoch';
import { INITIAL_STATUS, type RestoreContext, type SyncReason, type SyncStatus } from '../../platform/sync/types';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { retryFailedReloads } from './reloadRetry';
import type { DeviceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';

/**
 * État de la synchronisation pour l'interface (Y-02 critères 16 et 17, Y-03) : reflet de `SyncService.status()`, bouton
 * « Synchroniser » (désactivé pendant le cycle, D2 : rouvre la fenêtre de choix pendant `restore-choice`), fenêtre de choix après
 * restauration. Aucune clé ni aucun texte clair ici.
 */
export interface SyncState {
  readonly deviceNames: Readonly<Record<string, string>>;
  readonly deviceNamesLoaded: boolean;
  readonly deviceNameBusy: boolean;
  readonly deviceNameError: PlainMessageKey | null;
  loadDeviceNames(): Promise<void>;
  renameDevice(id: DeviceId, name: string): Promise<boolean>;
  readonly available: boolean;
  readonly status: SyncStatus;
  /** Cycle demandé depuis l'interface et pas encore terminé. */
  readonly busy: boolean;
  /** Fenêtre de choix après restauration ouverte (options de la règle 4). */
  readonly restore: RestoreContext | null;
  readonly choosing: boolean;
  syncNow(reason: Extract<SyncReason, 'manual' | 'tray'>): Promise<void>;
  openRestore(): Promise<void>;
  chooseRestore(option: RestoreOption): Promise<void>;
  closeRestore(): void;
}

export const syncStore = defineFeatureStore<SyncState>((container: AppContainer) => {
  const service = container.sync;
  let loadingNames: Promise<void> | null = null;
  const namedStatus = (status: SyncStatus, names: Readonly<Record<string, string>>): SyncStatus => ({ ...status, devices: status.devices.map((device) => ({ ...device, displayName: names[device.deviceId] })) });
  const store = createStore<SyncState>()((set, get) => ({
    deviceNames: {},
    deviceNamesLoaded: false,
    deviceNameBusy: false,
    deviceNameError: null,
    loadDeviceNames() {
      if (get().deviceNamesLoaded) return Promise.resolve();
      if (loadingNames) return loadingNames;
      loadingNames = (async () => {
        try {
          const raw = await container.data.repos.sync.getMeta('ui.deviceNames');
          const value: unknown = raw === null ? {} : JSON.parse(raw);
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-device-names');
          const names: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [id, name] of Object.entries(value)) {
            if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) || typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('invalid-device-name');
            names[id] = name;
          }
          set({ deviceNames: names, deviceNamesLoaded: true, deviceNameError: null, status: namedStatus(get().status, names) });
        } catch {
          set({ deviceNameError: 'sync.status.nameReadFailed' });
        } finally {
          loadingNames = null;
        }
      })();
      return loadingNames;
    },
    async renameDevice(id, name) {
      await get().loadDeviceNames();
      if (!get().deviceNamesLoaded || get().deviceNameBusy) return false;
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 80 || !get().status.devices.some((device) => device.deviceId === id)) {
        set({ deviceNameError: 'sync.status.nameInvalid' });
        return false;
      }
      const names = { ...get().deviceNames, [id]: trimmed };
      set({ deviceNameBusy: true });
      try {
        await container.data.repos.sync.setMeta('ui.deviceNames', JSON.stringify(names));
        set({ deviceNames: names, deviceNameError: null, status: namedStatus(get().status, names) });
        return true;
      } catch {
        set({ deviceNameError: 'sync.status.nameSaveFailed' });
        return false;
      } finally {
        set({ deviceNameBusy: false });
      }
    },
    available: service !== null,
    status: service?.status() ?? INITIAL_STATUS,
    busy: false,
    restore: null,
    choosing: false,
    async syncNow(reason) {
      if (!service) return;
      if (service.status().phase === 'restore-choice') {
        // D2 : la décision en attente suspend la synchro ; « Synchroniser » rouvre la fenêtre de choix.
        await get().openRestore();
        return;
      }
      if (get().busy) {
        void service.syncNow(reason);
        return;
      }
      set({ busy: true });
      try {
        await service.syncNow(reason);
        // Y-TECH-02 (seconde revue, point 1) : rechargements d'écran en échec retentés.
        await retryFailedReloads(container);
      } finally {
        set({ busy: false });
        if (service.status().phase === 'restore-choice' && reason === 'manual') await get().openRestore();
      }
    },
    async openRestore() {
      if (!service) return;
      try {
        set({ restore: await service.restoreContext() });
      } catch {
        // Contexte illisible : journalisé et rendu visible par le service (état `state-unreadable` ou phase d'erreur) ; fenêtre fermée.
        set({ restore: null });
      }
    },
    async chooseRestore(option) {
      if (!service || get().choosing) return;
      set({ choosing: true });
      let remaining: RestoreContext | null = get().restore;
      try {
        await service.chooseRestoreOption(option);
      } finally {
        // La fenêtre ne se ferme que si le choix a été exécuté (marqueur effacé) ; sinon elle reste, options relues.
        try {
          remaining = await service.restoreContext();
        } catch {
          // Contexte illisible : journalisé et rendu visible par le service ; la fenêtre reste telle quelle.
        }
        set({ choosing: false, restore: remaining });
      }
    },
    closeRestore() {
      set({ restore: null });
    },
  }));
  service?.subscribe(() => store.setState({ status: namedStatus(service.status(), store.getState().deviceNames) }));
  return store;
});
