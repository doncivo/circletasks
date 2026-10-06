import type { DeviceId } from '../../domain/types';
import { INITIAL_STATUS, type ForgetOutcome, type RejoinOutcome, type RemoteChanges, type RestoreContext, type SyncEngineService, type SyncReason, type SyncStatus } from '../../platform/sync/types';

/** Faux service de synchro pour les tests d'écran : état posé à la main, appels enregistrés, cycle libéré à la demande. */
export interface FakeSyncService extends SyncEngineService {
  setStatus(patch: Partial<SyncStatus>): void;
  readonly calls: SyncReason[];
  readonly choices: string[];
  /** Termine le cycle en cours (les `syncNow` attendent tant que `hold` est vrai). */
  release(): void;
  hold: boolean;
  restore: RestoreContext | null;
  /** Le choix est exécuté (marqueur effacé : `restore` devient null) ; faux : refusé ou échoué, le marqueur reste. */
  choiceExecuted: boolean;
  emitChanges(change: RemoteChanges): void;
  /** Y-10 : appareils dont l'oubli a été demandé, et issue rendue par `forgetDevice`. */
  readonly forgets: DeviceId[];
  forgetOutcome: ForgetOutcome;
  /** Y-10 : appels de « Associer de nouveau » et issue rendue. */
  rejoins: number;
  rejoinOutcome: RejoinOutcome;
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
    choiceExecuted: true,
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
      if (fake.choiceExecuted) fake.restore = null;
    },
    restoreContext: async () => fake.restore,
    running: () => null,
    forgets: [],
    forgetOutcome: { kind: 'done' },
    async forgetDevice(deviceId) {
      fake.forgets.push(deviceId);
      return fake.forgetOutcome;
    },
    rejoins: 0,
    rejoinOutcome: { kind: 'restart' },
    async rejoin() {
      fake.rejoins += 1;
      return fake.rejoinOutcome;
    },
  };
  return fake;
}
