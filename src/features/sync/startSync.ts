import { newerDevices, type DeviceState } from '../../domain/sync/compat';
import { QUIT_HANDLER_SYNC_MS, SYNCING_BANNER_DELAY_MS } from '../../domain/sync/limits';
import { DEVICE_STATES, syncBannerFor, type JoinFailureFact, type PersistedSyncFacts, type SyncTrouble } from '../../domain/syncBanners';
import type { DeviceId } from '../../domain/types';
import { t } from '../../i18n';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { startSyncScheduler, type SyncScheduler, type SyncSchedulerEnv } from '../../sync';
import { useAppStatusStore, type StatusSource } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import type { AppStatusKind } from '../../domain/appStatus';
import { useNavigationStore } from '../app/navigation';
import { JOIN_STATE_META, onPairingChange } from './pairingStatus';
import { applyRemoteChanges } from './remoteChanges';
import { syncStore } from './syncStore';
import { deviceName, deviceStatusText, statusLine } from './syncText';

export interface SyncIntegration {
  dispose(): void;
  /** Se résout quand la dernière relecture des états persistés est appliquée (tests : aucune attente par délai). */
  refreshed(): Promise<void>;
}

/** Environnement injectable (tests : document, horloge et minuteries factices ; aucun délai réel). */
export interface SyncIntegrationEnv extends Partial<SyncSchedulerEnv> {
  /** Minuteur du seuil de 1 s de « Synchro en cours » (A-09 critère 9 d). */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** Planificateur actif de chaque conteneur : « Quitter » (desktop.ts) passe par lui, jamais par un minuteur à part. */
const schedulers = new WeakMap<AppContainer, SyncScheduler>();

/** États A-09 posés par la synchro, tous retirés à `dispose()` (critère 9 j). */
const SYNC_KINDS = ['syncTrouble', 'updateRequired', 'waitingIcloud', 'syncing'] as const satisfies readonly AppStatusKind[];

const count = new Intl.NumberFormat('fr-FR');

/**
 * Texte d'un état `syncTrouble` (A-09 D5 : une seule formulation par état) : ligne de Réglages (`statusLine`) pour une phase, texte de
 * l'arrivée en échec de `JoinProgress` (Y-06), appareil nommé et statut comme dans APPAREILS.
 */
export function syncTroubleText(trouble: SyncTrouble<SyncDeviceStatus>, status: SyncStatus, devices: readonly SyncDeviceStatus[], nowMs: number): string {
  switch (trouble.code) {
    case 'join-failed':
      return trouble.join.failure === 'clock-ahead'
        ? t('sync.pairing.joinFailedClock')
        : t('sync.pairing.joinFailed', { done: count.format(trouble.join.done), total: count.format(trouble.join.total) });
    case 'device-foreign':
    case 'device-corrupt':
    case 'device-rollback':
      return t('status.syncDevice', { device: deviceName(trouble.device, devices), state: deviceStatusText(trouble.device.status) });
    case 'key-mismatch':
      // Phase `key-mismatch`, ou déduite avant le premier cycle (même texte).
      return status.phase === 'key-mismatch' ? statusLine(status, nowMs) : t('sync.status.keyMismatch');
    case 'needs-pairing':
    case 'restore-choice':
    case 'error':
    case 'clock-ahead':
      return statusLine(status, nowMs);
  }
}

/** Arrivée en échec gardée par le moteur (`sync_meta.join`, Y-06). Rejette si la base ne répond pas (l'état précédent est alors gardé). */
async function readJoinFailure(container: AppContainer): Promise<JoinFailureFact | null> {
  const raw = await container.data.repos.sync.getMeta(JOIN_STATE_META);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Valeur illisible : traitée comme absente, comme dans `JoinProgress`.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { done, total, failure } = value as Record<string, unknown>;
  if (typeof done !== 'number' || typeof total !== 'number' || typeof failure !== 'string') return null;
  return { done, total, failure };
}

/** Appareils de `sync_state` avant le premier cycle (mêmes règles d'affichage que le moteur : soi, ou un état déjà accepté). */
async function readStoredDevices(container: AppContainer): Promise<SyncDeviceStatus[]> {
  const rows = await container.data.repos.sync.getStates();
  return rows
    .filter((row) => row.isSelf || row.stateSeq > 0)
    .map((row) => ({
      deviceId: row.deviceId as DeviceId,
      platform: row.platform === 'ios' ? 'ios' : 'windows',
      self: row.isSelf,
      lastReadAt: null,
      status: ((DEVICE_STATES as readonly string[]).includes(row.status) ? row.status : 'active') as DeviceState,
    }));
}

/**
 * Branche la synchro sur l'app (Y-02 critères 1, 17 et 18) : planificateur (ouverture, 5 min fenêtre visible, masquage), bandeaux A-09
 * et rechargement des stores après chaque lot reçu. Sans synchro (`container.sync` null) : rien, aucun coût.
 *
 * Bandeaux (A-09 critère 9, décision de `syncBanners.ts`) : `syncTrouble` (phase en échec ou bloquée, arrivée en échec, appareils
 * `foreign` / `corrupt` / `rollback`, le plus urgent avec « (+N) » et « Voir »), « En attente d'iCloud » (avec sa cause), « Synchro en
 * cours » (seulement après 1 s), « Mettez à jour l'app » (Y-07). « Hors ligne » n'est jamais retiré ici. Les états persistés sont relus
 * au démarrage (avant le premier cycle), après chaque changement d'état et d'association ; une lecture en échec garde l'état précédent
 * (aucune disparition sans résolution, critère 9 i).
 */
export function startSyncIntegration(container: AppContainer, env: SyncIntegrationEnv = {}): SyncIntegration {
  const sync = container.sync;
  if (!sync) return { dispose: () => undefined, refreshed: () => Promise.resolve() };
  const setTimer = env.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = env.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  let persisted: PersistedSyncFacts<SyncDeviceStatus> = { join: null, devices: null };
  /** Un cycle a conclu depuis le démarrage : l'état exposé fait foi pour les appareils. */
  let concluded = false;
  /** Dernier état hors cycle (phase en échec gardée pendant le cycle suivant). */
  let settled: SyncStatus | null = sync.status().phase === 'syncing' ? null : sync.status();
  let syncingTimer: unknown = null;
  let syncingShown = false;
  let readSeq = 0;
  let lastRefresh: Promise<void> = Promise.resolve();

  const put = (kind: AppStatusKind, source: StatusSource | null): void => {
    const store = useAppStatusStore.getState();
    const previous = store.sources[kind];
    if (source === null) {
      if (previous !== undefined) store.setStatus(kind, null);
      return;
    }
    // Même état, même texte : rien ne change (aucun rendu ni clignotement).
    if (previous && previous.detail === source.detail && previous.message === source.message && previous.more === source.more) return;
    store.setStatus(kind, source);
  };

  const actionFor = (trouble: SyncTrouble<SyncDeviceStatus>): (() => void) =>
    trouble.code === 'restore-choice'
      ? () => void syncStore.get(container).getState().openRestore()
      : () => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'sync' });

  const stopSyncingTimer = (): void => {
    if (syncingTimer === null) return;
    clearTimer(syncingTimer);
    syncingTimer = null;
  };

  const applyBanners = (): void => {
    if (disposed) return;
    const current = sync.status();
    const nowMs = container.clock.nowMs();
    const banners = syncBannerFor(current, persisted, settled);

    const [first, ...others] = banners.troubles;
    if (first) {
      // Pendant un cycle, le texte est celui de la phase qui a conclu le cycle précédent.
      const textStatus = current.phase === 'syncing' && settled ? settled : current;
      put('syncTrouble', { detail: first.code, message: syncTroubleText(first, textStatus, banners.devices, nowMs), more: others.length, onAction: actionFor(first) });
    } else put('syncTrouble', null);

    // Critère 9 e : cause connue, texte de la ligne de Réglages (sans l'échec de réintégration, montré par `updateRequired`).
    put('waitingIcloud', banners.waitingIcloud ? (banners.waitingIcloud.cause ? { message: statusLine({ ...current, reintegrationFailure: null }, nowMs) } : {}) : null);

    // Critère 9 d : « Synchro en cours » seulement si le cycle dure plus de 1 s.
    if (banners.syncing) {
      if (!syncingShown && syncingTimer === null) {
        syncingTimer = setTimer(() => {
          syncingTimer = null;
          if (disposed || sync.status().phase !== 'syncing') return;
          syncingShown = true;
          put('syncing', {});
        }, SYNCING_BANNER_DELAY_MS);
      }
    } else {
      stopSyncingTimer();
      syncingShown = false;
      put('syncing', null);
    }

    // Y-07 critère 9 : tant qu'un autre appareil actif publie une version plus récente ; jamais sans synchro configurée.
    const configured = current.phase !== 'not-configured' && current.phase !== 'needs-pairing';
    // Exigence d'Ali : un échec de réintégration prime (rien d'autre ne le montre depuis l'écran principal) ; même état A-09.
    // L'échec vient du démarrage, pas de la synchro : signalé même sans synchro configurée (revue 2) ; un appareil plus récent, non.
    put('updateRequired', current.reintegrationFailure ? { detail: 'reintegration' } : configured && newerDevices(current.devices).length > 0 ? {} : null);
  };

  /** Relit les états persistés ; une lecture en échec garde les valeurs précédentes (jamais un retrait sans résolution). */
  const refreshPersisted = (): Promise<void> => (lastRefresh = readPersisted());
  const readPersisted = async (): Promise<void> => {
    const seq = ++readSeq;
    const wantDevices = !concluded;
    let join = persisted.join;
    let devices = persisted.devices;
    try {
      join = await readJoinFailure(container);
    } catch {
      // base occupée : état précédent gardé
    }
    if (wantDevices) {
      try {
        devices = await readStoredDevices(container);
      } catch {
        // base occupée : état précédent gardé
      }
    }
    if (disposed || seq !== readSeq) return;
    persisted = { join, devices: concluded ? null : devices };
    applyBanners();
  };

  const onStatus = (): void => {
    const current = sync.status();
    if (current.phase !== 'syncing' && current.progress === null) {
      settled = current;
      if (!concluded) {
        concluded = true;
        persisted = { ...persisted, devices: null };
      }
    }
    applyBanners();
    void refreshPersisted();
  };

  const stopStatus = sync.subscribe(onStatus);
  const stopPairing = onPairingChange(container, () => void refreshPersisted());
  const stopChanges = sync.onRemoteChanges((change) => void applyRemoteChanges(container, change).catch(() => undefined));
  applyBanners();
  void refreshPersisted();
  const scheduler = startSyncScheduler(sync, { document: env.document ?? document, clock: env.clock ?? container.clock, ...(env.setInterval ? { setInterval: env.setInterval } : {}), ...(env.clearInterval ? { clearInterval: env.clearInterval } : {}) });
  schedulers.set(container, scheduler);
  return {
    refreshed: async () => {
      // Une relecture peut en lancer une autre (changement d'état) : attendre la dernière.
      let seen: Promise<void> | null = null;
      while (seen !== lastRefresh) {
        seen = lastRefresh;
        await seen;
      }
    },
    dispose: () => {
      disposed = true;
      if (schedulers.get(container) === scheduler) schedulers.delete(container);
      scheduler.dispose();
      stopStatus();
      stopPairing();
      stopChanges();
      stopSyncingTimer();
      for (const kind of SYNC_KINDS) useAppStatusStore.getState().setStatus(kind, null);
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
