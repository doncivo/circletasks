import type { LedgerRead, NotificationLedgerV1 } from '../../domain/notificationLedger';
import type { NotificationLedger } from './notificationLedger';
import type { IosNotificationBridge, PendingItem, ShowPayload } from './tauriNotifications';
import { NotificationSchedulerError, type NotificationPermission } from './types';

/**
 * Faux du pont iOS pour les tests (adaptateur, cas d'usage des rappels) : les notifications en attente vivent en mémoire comme chez
 * `UNUserNotificationCenter`, les appels sont enregistrés, les échecs sont injectables. Jamais importé par le code de l'app.
 */
export interface FakeBridge extends IosNotificationBridge {
  readonly calls: string[];
  readonly pendingMap: Map<number, PendingItem & { date: string }>;
  readonly shown: ShowPayload[];
  readonly cancels: number[][];
  permissionState: NotificationPermission | 'unavailable';
  failShow: (payload: ShowPayload) => boolean;
  failCancel: boolean;
  failPending: boolean;
  /** `show` réussit mais iOS ne garde rien (échec silencieux de `UNUserNotificationCenter.add`). */
  dropOnShow: (payload: ShowPayload) => boolean;
}

export function createFakeBridge(): FakeBridge {
  const bridge: FakeBridge = {
    calls: [],
    pendingMap: new Map(),
    shown: [],
    cancels: [],
    permissionState: 'granted',
    failShow: () => false,
    failCancel: false,
    failPending: false,
    dropOnShow: () => false,
    show: (payload) => {
      bridge.calls.push('show');
      if (bridge.failShow(payload)) return Promise.reject(new Error('refusé'));
      bridge.shown.push(payload);
      if (!bridge.dropOnShow(payload)) bridge.pendingMap.set(payload.id, { id: payload.id, title: payload.title, body: payload.body, date: payload.schedule.at.date });
      return Promise.resolve();
    },
    cancel: (ids) => {
      bridge.calls.push('cancel');
      bridge.cancels.push([...ids]);
      if (bridge.failCancel) return Promise.reject(new Error('refusé'));
      for (const id of ids) bridge.pendingMap.delete(id);
      return Promise.resolve();
    },
    pending: () => {
      bridge.calls.push('pending');
      return bridge.failPending ? Promise.reject(new Error('illisible')) : Promise.resolve([...bridge.pendingMap.values()].map(({ id, title, body }) => ({ id, title, body })));
    },
    permission: () => {
      bridge.calls.push('permission');
      return bridge.permissionState === 'unavailable' ? Promise.reject(new NotificationSchedulerError('unavailable')) : Promise.resolve(bridge.permissionState);
    },
    requestPermission: () => Promise.resolve(bridge.permissionState === 'unavailable' ? 'denied' : bridge.permissionState),
  };
  return bridge;
}

export interface MemoryLedger extends NotificationLedger {
  value: unknown;
  read: LedgerRead;
  failSave: boolean;
  saves: NotificationLedgerV1[];
}

export function createMemoryLedger(): MemoryLedger {
  const ledger: MemoryLedger = {
    value: null,
    read: { state: 'missing' },
    failSave: false,
    saves: [],
    load: () => Promise.resolve(ledger.read),
    save: (next) => {
      if (ledger.failSave) return Promise.reject(new Error('écriture impossible'));
      ledger.saves.push(next);
      ledger.read = { state: 'valid', ledger: next };
      return Promise.resolve();
    },
  };
  return ledger;
}

