import type { DataAccess } from '../db/repositories';
import type { Clock } from '../domain/clock';
import type { HlcClock } from '../domain/hlc';
import { parseReintegrationFailure, REINTEGRATION_FAILURE_META, type ReintegrationFailure } from '../domain/sync/compat';
import type { RestoreOption } from '../domain/sync/epoch';
import type { SyncDevicePlatform } from '../domain/sync/format';
import type { DeviceId, IsoDateTime } from '../domain/types';
import type { RemoteChanges, SyncEngineService, SyncPlatform, SyncReason, SyncStatus } from '../platform/sync/types';
import type { SyncDeps } from './deps';
import { runCycle, type CycleOptions, type CycleResult } from './engine';
import { defaultSyncLogger, type SyncLogger } from './log';
import { applyEverywhere, prepareKeepSynced, restoreContext } from './restoreChoice';
import { INITIAL_STATUS, statusFromFacts } from './status';

/**
 * Service de synchronisation exposé par le conteneur (`AppContainer.sync`, ADR 0011 section 11.2 ; Y-02, Y-03, Y-05).
 *
 * - Un seul cycle à la fois ; une demande pendant un cycle en programme **un seul** de plus (section 10.1).
 * - `syncNow` ne rejette jamais ; le résultat se lit dans `status()`.
 * - Phase `syncing` seulement si le cycle lit ou écrit, ou s'il dure plus d'une seconde (A-09).
 * - Marqueur de restauration : aucun cycle ; `chooseRestoreOption` applique le choix puis efface le marqueur.
 */
export type { SyncEngineService };

export interface SyncServiceOptions {
  readonly data: DataAccess;
  readonly platform: SyncPlatform;
  readonly hlc: HlcClock;
  readonly clock: Clock;
  readonly deviceId: DeviceId;
  readonly devicePlatform?: SyncDevicePlatform;
  readonly appVersion?: string;
  readonly sv: number;
  readonly logger?: SyncLogger;
  /** Minuteur du seuil d'une seconde (tests : injecté). */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const SYNCING_DELAY_MS = 1_000;
const WEEK_MS = 7 * 86_400_000;

export function createSyncService(options: SyncServiceOptions): SyncEngineService {
  const deps: SyncDeps = {
    data: options.data,
    platform: options.platform,
    hlc: options.hlc,
    clock: options.clock,
    deviceId: options.deviceId,
    devicePlatform: options.devicePlatform ?? 'windows',
    appVersion: options.appVersion ?? '0.0.0',
    sv: options.sv,
    logger: options.logger ?? defaultSyncLogger,
  };
  const setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let status: SyncStatus = INITIAL_STATUS;
  const listeners = new Set<() => void>();
  const changeListeners = new Set<(c: RemoteChanges) => void>();
  let current: Promise<void> | null = null;
  /**
   * File par type d'action (section 10.1) : un seul cycle de synchro de plus, quel que soit le nombre de demandes pendant le cycle en
   * cours ; le choix après restauration a sa propre place (le dernier choix demandé) et passe **avant** la synchro en attente. Un choix
   * n'est donc jamais absorbé par une synchro déjà programmée.
   */
  type ActionKind = 'choice' | 'sync';
  const waiting = new Map<ActionKind, { run: () => Promise<unknown>; done: () => void; promise: Promise<void> }>();

  const publish = (next: SyncStatus): void => {
    status = next;
    for (const listener of listeners) listener();
  };

  const emitChanges = (touched: ReadonlyMap<string, ReadonlySet<string>>): void => {
    if (touched.size === 0) return;
    const change: RemoteChanges = { tables: new Set(touched.keys()), ids: touched };
    for (const listener of changeListeners) {
      try {
        listener(change);
      } catch {
        // un abonné en échec n'arrête pas la synchro
      }
    }
  };

  const finish = async (result: CycleResult): Promise<void> => {
    let conflicts = status.conflictsThisWeek;
    try {
      conflicts = await options.data.repos.sync.countConflictsSince(new Date(options.clock.nowMs() - WEEK_MS).toISOString() as IsoDateTime);
    } catch {
      // base occupée : valeur précédente
    }
    // Y-07 (exigence d'Ali) : échec de réintégration du dernier démarrage, gardé dans sync_meta par la réintégration.
    let reintegrationFailure: ReintegrationFailure | null | undefined;
    try {
      reintegrationFailure = parseReintegrationFailure(await options.data.repos.sync.getMeta(REINTEGRATION_FAILURE_META));
    } catch {
      // base occupée : valeur précédente
    }
    publish(
      statusFromFacts(status, result, {
        folderLabel: result.folderLabel ?? status.folderLabel,
        folderKind: result.folderKind ?? status.folderKind ?? null,
        lastSyncAt: result.lastSyncAt ?? status.lastSyncAt,
        conflictsThisWeek: conflicts,
        ...(reintegrationFailure === undefined ? {} : { reintegrationFailure }),
      }),
    );
  };

  const cycle = async (cycleOptions: CycleOptions = {}): Promise<CycleResult> => {
    const before = status;
    const markSyncing = (): void => {
      if (status.phase !== 'syncing') publish({ ...status, phase: 'syncing' });
    };
    const timer = setTimer(markSyncing, SYNCING_DELAY_MS);
    try {
      const result = await runCycle(deps, { onRemoteChanges: emitChanges, onWork: markSyncing, onProgress: (done, total) => publish({ ...status, progress: { done, total } }) }, cycleOptions);
      await finish(result);
      return result;
    } catch (error) {
      deps.logger.log('cycle-crashed', { code: 'io' });
      publish({ ...before, phase: 'error', errorCode: 'io' });
      void error;
      return { outcome: 'failed', errorCode: 'io', pendingFiles: [], devices: [], keyMismatch: false, folderLabel: null, lastSyncAt: null, worked: false };
    } finally {
      clearTimer(timer);
    }
  };

  const pump = (): void => {
    if (current) return;
    const kind: ActionKind | null = waiting.has('choice') ? 'choice' : waiting.has('sync') ? 'sync' : null;
    if (kind === null) return;
    const next = waiting.get(kind) as { run: () => Promise<unknown>; done: () => void };
    waiting.delete(kind);
    current = next
      .run()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        current = null;
        next.done();
        pump();
      });
  };

  const schedule = (kind: ActionKind, run: () => Promise<unknown>): Promise<void> => {
    const existing = waiting.get(kind);
    if (existing) {
      // Synchro : la demande déjà en attente suffit. Choix : le plus récent remplace celui qui n'a pas encore commencé.
      if (kind === 'choice') existing.run = run;
      return existing.promise;
    }
    let done: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    waiting.set(kind, { run, done, promise });
    pump();
    return promise;
  };

  const service: SyncEngineService = {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncNow: (reason: SyncReason) => {
      deps.logger.log('sync-now', { reason });
      return schedule('sync', () => cycle());
    },
    onRemoteChanges: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    async restoreContext() {
      try {
        const marker = await options.platform.restoreMarker.get();
        return marker ? await restoreContext(deps, marker) : null;
      } catch {
        return null;
      }
    },
    chooseRestoreOption: (option: RestoreOption) =>
      schedule('choice', async () => {
        const context = await service.restoreContext();
        if (!context || !context.options.includes(option)) {
          deps.logger.log('restore-choice-refused', { option });
          return;
        }
        deps.logger.log('restore-choice', { option });
        if (option === 'apply-everywhere') {
          await applyEverywhere(deps);
          await options.platform.restoreMarker.clear();
          await cycle();
          return;
        }
        await prepareKeepSynced(deps);
        const result = await cycle({ ignoreMarker: true, forceResume: true });
        if (result.outcome === 'done') {
          await options.platform.restoreMarker.clear();
          await finish(result);
        }
      }).catch(() => undefined),
    running: () => current,
  };
  return service;
}
