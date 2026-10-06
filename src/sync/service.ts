import type { DataAccess } from '../db/repositories';
import type { Clock } from '../domain/clock';
import type { HlcClock } from '../domain/hlc';
import { parseReintegrationFailure, REINTEGRATION_FAILURE_META, type ReintegrationFailure } from '../domain/sync/compat';
import type { RestoreOption } from '../domain/sync/epoch';
import { SYNCING_BANNER_DELAY_MS } from '../domain/sync/limits';
import type { SyncDevicePlatform } from '../domain/sync/format';
import type { DeviceId, IsoDateTime } from '../domain/types';
import { syncErrorCodeOf, type ForgetOutcome, type RejoinOutcome, type RemoteChanges, type ResetOutcome, type SyncEngineService, type SyncForgetStatus, type SyncPlatform, type SyncReason, type SyncResetStatus, type SyncStatus } from '../platform/sync/types';
import { declareForget, prepareRejoin, readForgetStatus } from './forget';
import { beginReset, dismissResetState, readResetState, readResetStatus, recordResetFailure } from './reset';
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
 * - Phase `syncing` seulement si le cycle lit ou écrit, ou s'il dure plus de `SYNCING_BANNER_DELAY_MS` ; elle porte l'heure de début du
 *   cycle (`cycleStartedAt`), d'où le bandeau A-09 compte son seuil (un seul seuil, jamais deux délais cumulés).
 * - Un abonné qui lève est journalisé et n'empêche ni les autres abonnés ni la synchro (revue A-09, point 2).
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
  /** Minuteur du seuil `SYNCING_BANNER_DELAY_MS` (tests : injecté). */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Y-10 (« Associer de nouveau ») : nouvel identifiant d'appareil (UUID v4 en minuscules) ; tests : injecté. */
  readonly newDeviceId?: () => DeviceId;
}

const randomDeviceId = (): DeviceId => crypto.randomUUID().toLowerCase() as DeviceId;

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
  type ActionKind = 'choice' | 'forget' | 'reset' | 'sync';
  const waiting = new Map<ActionKind, { run: () => Promise<unknown>; done: () => void; promise: Promise<void> }>();

  const publish = (next: SyncStatus): void => {
    status = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Un écran en échec n'arrête ni la synchro ni les autres abonnés ; le bandeau A-09 a son propre repli visible (startSync.ts).
        deps.logger.log('status-listener-failed', { code: 'io' });
      }
    }
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

  /** État sans l'heure de début de cycle (posée seulement pendant la phase `syncing`). */
  const withoutCycleStart = (value: SyncStatus): SyncStatus => {
    const { cycleStartedAt, ...rest } = value;
    void cycleStartedAt;
    return rest;
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
    // Y-10 (exigence d'Ali) : échec d'un oubli et suppressions en attente, gardés dans sync_meta jusqu'à leur résolution.
    let forget: SyncForgetStatus | null | undefined;
    try {
      forget = await readForgetStatus(options.data.repos);
    } catch {
      // base occupée : valeur précédente
    }
    // Y-11 (exigence d'Ali) : réinitialisation en cours, en échec, à réassocier ou terminée, gardée dans sync_meta.
    let reset: SyncResetStatus | null | undefined;
    try {
      reset = await readResetStatus(options.data.repos, options.clock.nowMs());
    } catch {
      // base occupée : valeur précédente
    }
    publish(
      statusFromFacts(withoutCycleStart(status), result, {
        folderLabel: result.folderLabel ?? status.folderLabel,
        folderKind: result.folderKind ?? status.folderKind ?? null,
        lastSyncAt: result.lastSyncAt ?? status.lastSyncAt,
        conflictsThisWeek: conflicts,
        ...(reintegrationFailure === undefined ? {} : { reintegrationFailure }),
        ...(forget === undefined ? {} : { forget }),
        ...(reset === undefined ? {} : { reset }),
      }),
    );
  };

  /** Y-11 : état de la réinitialisation relu de sync_meta et publié sans cycle (échec du lancement, visible aussitôt). */
  const refreshReset = async (): Promise<void> => {
    try {
      const reset = await readResetStatus(options.data.repos, options.clock.nowMs());
      const { reset: _previous, ...rest } = status;
      publish(reset ? { ...rest, reset } : rest);
    } catch {
      // base occupée : l'état sera relu à la fin du prochain cycle
    }
  };

  /** Y-10 : état de l'oubli relu de sync_meta et publié sans cycle (échec d'une déclaration, visible aussitôt). */
  const refreshForget = async (): Promise<void> => {
    try {
      const forget = await readForgetStatus(options.data.repos);
      const { forget: _previous, ...rest } = status;
      publish(forget ? { ...rest, forget } : rest);
    } catch {
      // base occupée : l'état sera relu à la fin du prochain cycle
    }
  };

  /** Premier cycle de ce service (démarrage) : une étape de réinitialisation en cours y est « reprise » (dit par l'écran, critère 17). */
  let firstCycle = true;

  const cycle = async (cycleOptions: CycleOptions = {}): Promise<CycleResult> => {
    const before = status;
    const cycleStartedAt = options.clock.nowMs();
    const markSyncing = (): void => {
      if (status.phase !== 'syncing') publish({ ...status, phase: 'syncing', cycleStartedAt });
    };
    const timer = setTimer(markSyncing, SYNCING_BANNER_DELAY_MS);
    try {
      if (firstCycle) {
        firstCycle = false;
        await markResumed();
      }
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

  /** Y-11 : une réinitialisation trouvée en cours au démarrage (arrêt pendant l'annonce, l'ouverture ou la bascule) est marquée reprise. */
  const markResumed = async (): Promise<void> => {
    try {
      const stored = await readResetState(options.data.repos);
      if (stored && (stored.step === 'announced' || stored.step === 'snapshot' || stored.step === 'switching') && !stored.resumed) {
        await options.data.repos.sync.setMeta('resetState', JSON.stringify({ ...stored, resumed: true }));
        deps.logger.log('reset-resumed', { step: stored.step });
      }
    } catch {
      // base occupée : l'étape reste affichée telle quelle ; elle sera reprise par le cycle
      deps.logger.log('reset-resume-unmarked', { code: 'io' });
    }
  };

  const pump = (): void => {
    if (current) return;
    const kind: ActionKind | null = waiting.has('choice') ? 'choice' : waiting.has('forget') ? 'forget' : waiting.has('reset') ? 'reset' : waiting.has('sync') ? 'sync' : null;
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
      // Synchro : la demande déjà en attente suffit. Choix : le plus récent remplace celui qui n'a pas encore commencé. Oubli (Y-10) :
      // les demandes s'enchaînent (aucune n'est absorbée).
      if (kind === 'choice') existing.run = run;
      if (kind === 'forget') {
        const before = existing.run;
        existing.run = async () => {
          await before();
          await run();
        };
      }
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
    async forgetDevice(deviceId: DeviceId): Promise<ForgetOutcome> {
      let outcome: ForgetOutcome = { kind: 'failed', code: 'io' };
      await schedule('forget', async () => {
        outcome = await declareForget(deps, deviceId).catch((): ForgetOutcome => ({ kind: 'failed', code: 'io' }));
        if (outcome.kind !== 'done') {
          // Échec gardé dans sync_meta : affiché sans attendre le prochain cycle.
          await refreshForget();
          return;
        }
        // Publication de la déclaration (Rust complète la liste), puis application de l'oubli (ordre total, coupure, suppression).
        await cycle();
        await cycle();
      }).catch(() => undefined);
      return outcome;
    },
    async rejoin(): Promise<RejoinOutcome> {
      let outcome: RejoinOutcome = { kind: 'failed', code: 'io' };
      await schedule('forget', async () => {
        outcome = await prepareRejoin(deps, (options.newDeviceId ?? randomDeviceId)()).catch((): RejoinOutcome => ({ kind: 'failed', code: 'io' }));
        if (outcome.kind === 'failed') await refreshForget();
      }).catch(() => undefined);
      return outcome;
    },
    async resetSync(): Promise<ResetOutcome> {
      let outcome: ResetOutcome = { kind: 'failed', code: 'io' };
      await schedule('reset', async () => {
        outcome = await runReset();
        await refreshReset();
      }).catch(() => undefined);
      return outcome;
    },
    async dismissReset(): Promise<void> {
      await schedule('reset', async () => {
        await dismissResetState(deps);
        await refreshReset();
      }).catch(() => undefined);
    },
  };

  /**
   * Y-11 : un cycle (lecture de chaque appareil jusqu'à sa tête, accusés publiés), précondition (« Synchronisez d'abord »), confirmation
   * native et `K2` (Rust), puis les cycles qui publient l'annonce et ouvrent l'époque visée, et la bascule si aucun autre appareil n'est
   * attendu (appareil seul : au premier cycle). Refus de la boîte : annulation, rien n'est gardé ; tout autre échec : gardé et rendu.
   */
  const runReset = async (): Promise<ResetOutcome> => {
    const checked = await cycle({ resetCheck: true });
    if (checked.outcome !== 'done') {
      const code = checked.errorCode ?? 'state-mismatch';
      await recordResetFailure(deps, 'start', code);
      return { kind: 'failed', code };
    }
    if (checked.resetLag) {
      await recordResetFailure(deps, 'start', 'state-mismatch');
      deps.logger.log('reset-lagging', { device: checked.resetLag.device, reason: checked.resetLag.reason });
      return { kind: 'lagging', device: checked.resetLag.device };
    }
    let kid: string;
    try {
      ({ kid } = await options.platform.reset.start());
    } catch (error) {
      const code = syncErrorCodeOf(error);
      if (code === 'consent-denied') {
        // Choix de l'utilisateur : rien n'est créé ni gardé (un échec de lancement précédent est retiré).
        await dismissResetState(deps);
        deps.logger.log('reset-cancelled', {});
        return { kind: 'cancelled' };
      }
      await recordResetFailure(deps, 'start', code);
      return code === 'state-mismatch' ? { kind: 'lagging', device: null } : { kind: 'failed', code };
    }
    const stored = await readResetState(options.data.repos);
    if (!stored || stored.role !== 'initiator' || stored.kid !== kid || stored.step === 'start') await beginReset(deps, kid);
    // Annonce et ouverture de l'époque visée, puis bascule au scan suivant si aucun autre appareil n'est attendu.
    await cycle();
    await cycle();
    const after = await readResetState(options.data.repos);
    return { kind: 'started', switched: after?.step === 'done' };
  };

  return service;
}
