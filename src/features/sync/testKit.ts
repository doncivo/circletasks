import type { RemoteChanges, SyncReason, SyncStatus } from '../../platform/sync/types';
import type { RestoreContext, SyncEngineService } from '../../sync';
import { INITIAL_STATUS } from '../../sync';

/** Faux service de synchro pour les tests d'écran : état posé à la main, appels enregistrés, cycle libéré à la demande. */
export interface FakeSyncService extends SyncEngineService {
  setStatus(patch: Partial<SyncStatus>): void;
  readonly calls: SyncReason[];
  readonly choices: string[];
  /** Termine le cycle en cours (les `syncNow` attendent tant que `hold` est vrai). */
  release(): void;
  hold: boolean;
  restore: RestoreContext | null;
  emitChanges(change: RemoteChanges): void;
}

export function createFakeSyncService(initial: Partial<SyncStatus> = {}): FakeSyncService {
  let status: SyncStatus = { ...INITIAL_STATUS, ...initial };
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(c: RemoteChanges) => void>();
  let waiting: (() => void)[] = [];
  const fake: FakeSyncService = {
    calls: [],
    choices: [],
    hold: false,
    restore: null,
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStatus(patch) {
      status = { ...status, ...patch };
      for (const l of listeners) l();
    },
    syncNow(reason) {
      fake.calls.push(reason);
      return fake.hold ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
    release() {
      const pending = waiting;
      waiting = [];
      for (const resolve of pending) resolve();
    },
    onRemoteChanges(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    emitChanges(change) {
      for (const l of changeListeners) l(change);
    },
    async chooseRestoreOption(option) {
      fake.choices.push(option);
    },
    restoreContext: async () => fake.restore,
    running: () => null,
  };
  return fake;
}
