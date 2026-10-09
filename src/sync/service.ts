import { isRestoreQuiet } from '../platform/quiet';
import type { DataAccess } from '../db/repositories';
import { isSyncStateUnreadable, parseStoredIso } from '../domain/sync/stored';
import type { Clock } from '../domain/clock';
import type { HlcClock } from '../domain/hlc';
import { parseReintegrationFailure, REINTEGRATION_FAILURE_META, type ReintegrationFailure } from '../domain/sync/compat';
import type { RestoreOption } from '../domain/sync/epoch';
import { SYNCING_BANNER_DELAY_MS } from '../domain/sync/limits';
import type { SyncDevicePlatform } from '../domain/sync/format';
import type { DeviceId, IsoDateTime } from '../domain/types';
import { syncErrorCodeOf, type ForgetOutcome, type RejoinOutcome, type RemoteChanges, type ResetOutcome, type RestoreContext, type SyncEngineService, type SyncForgetStatus, type SyncNowOptions, type SyncPlatform, type SyncErrorCode, type SyncReason, type SyncResetStatus, type SyncStatus } from '../platform/sync/types';
import type { DeadlineUnit } from './deadline';
import { declareForget, prepareRejoin, readForgetStatus } from './forget';
import { beginReset, dismissResetState, readResetState, readResetStatus, recordResetFailure, RESET_META } from './reset';
import type { SyncDeps } from './deps';
import { runCycle, type CycleOptions, type CycleResult } from './engine';
import { defaultSyncLogger, type SyncLogger } from './log';
import { applyEverywhere, prepareKeepSynced, recordRestoreFailure, RESTORE_FAILURE_META, restoreContext } from './restoreChoice';
import { META, writeJson } from './meta';
import { INITIAL_STATUS, errorRepeat, phaseOf, statusFromFacts } from './status';
import { omitKey } from '../domain/omitKey';

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
  /** Numéro d'application publié (I-06 : `platform/appVersion.ts`, `unknown` si illisible) ; obligatoire, jamais un repli `0.0.0`. */
  readonly appVersion: string;
  readonly sv: number;
  readonly logger?: SyncLogger;
  /** Minuteur du seuil `SYNCING_BANNER_DELAY_MS` (tests : injecté). */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Y-10 (« Associer de nouveau ») : nouvel identifiant d'appareil (UUID v4 en minuscules) ; tests : injecté. */
  readonly newDeviceId?: () => DeviceId;
  /** Tests (ADR 0011 §22 point 6) : appelé avant chaque comparaison à l'échéance d'un cycle borné (arrêt à une frontière choisie). */
  readonly deadlineProbe?: (unit: DeadlineUnit) => void;
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
    appVersion: options.appVersion,
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
  /** Échéance du cycle de synchro en attente (cycle `hide` de l'iPhone) ; undefined : non borné. */
  let nextDeadline: number | undefined;
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
      } catch (error) {
        // Un abonné en échec n'arrête ni la synchro ni les autres abonnés ; journalisé comme `publish` (code seulement, jamais le message).
        deps.logger.log('remote-listener-failed', { code: syncErrorCodeOf(error) });
      }
    }
  };

  /** État sans l'heure de début de cycle (posée seulement pendant la phase `syncing`). */
  const withoutCycleStart = (value: SyncStatus): SyncStatus => {
    const { cycleStartedAt, ...rest } = value;
    void cycleStartedAt;
    return rest;
  };

  /**
   * Lecture de l'état local (`sync_meta`, `conflict_log`) en échec (base occupée, valeur illisible) : journalisée, valeur précédente
   * gardée et `state-unreadable` posé (§19 point 7) jusqu'à la fin de cycle suivante dont toutes les lectures réussissent.
   */
  const readFailed = (what: string, error: unknown): void => {
    deps.logger.log('state-read-failed', { what, code: syncErrorCodeOf(error) });
  };

  /**
   * Échec hors cycle rendu visible (revue, suggestion 7) : valeur stockée illisible → `state-unreadable` ; toute autre erreur → phase
   * d'erreur avec son code réel.
   */
  const signalFailure = (error: unknown): void => {
    if (isSyncStateUnreadable(error)) publish({ ...status, stateUnreadable: true });
    else publish({ ...status, phase: 'error', errorCode: syncErrorCodeOf(error) });
  };

  /** Contexte de la fenêtre de choix ; toute erreur remonte (jamais lue comme « aucun marqueur »). */
  const loadRestoreContext = async (): Promise<RestoreContext | null> => {
    const marker = await options.platform.restoreMarker.get();
    return marker ? await restoreContext(deps, marker) : null;
  };

  const finish = async (result: CycleResult): Promise<void> => {
    let unreadable = false;
    const read = async <T>(what: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        readFailed(what, error);
        unreadable = true;
        return undefined;
      }
    };
    const conflicts = (await read('conflicts', () => options.data.repos.sync.countConflictsSince(new Date(options.clock.nowMs() - WEEK_MS).toISOString() as IsoDateTime))) ?? status.conflictsThisWeek;
    // Y-07 (exigence d'Ali) : échec de réintégration du dernier démarrage, gardé dans sync_meta par la réintégration.
    const reintegrationFailure: ReintegrationFailure | null | undefined = await read('reintegration', async () => parseReintegrationFailure(await options.data.repos.sync.getMeta(REINTEGRATION_FAILURE_META)));
    // Y-10 (exigence d'Ali) : échec d'un oubli et suppressions en attente, gardés dans sync_meta jusqu'à leur résolution.
    const forget: SyncForgetStatus | null | undefined = await read('forget', () => readForgetStatus(options.data.repos));
    // Y-11 (exigence d'Ali) : réinitialisation en cours, en échec, à réassocier ou terminée, gardée dans sync_meta.
    const reset: SyncResetStatus | null | undefined = await read('reset', () => readResetStatus(options.data.repos, options.clock.nowMs()));
    // Seconde revue, point 6 : début de l'attente d'iCloud (sync_meta, survit au redémarrage) ; référence de l'attente prolongée quand
    // aucune synchro n'a jamais été complète.
    const waiting = phaseOf(result) === 'waiting-icloud';
    // Troisième revue, point M1 : valeur stockée non ISO → `state-unreadable` visible pour ce cycle (journalisé), puis remplacée comme
    // une valeur absente (début de l'attente : maintenant ; hors attente : effacée) ; le cycle suivant la relit valide et retire l'état.
    const waitingSince = await read('waiting', async () => {
      const raw = await options.data.repos.sync.getMeta(META.waitingSince);
      let stored: IsoDateTime | null = null;
      let invalid = false;
      try {
        stored = parseStoredIso(raw, `sync_meta.${META.waitingSince}`, deps.logger);
      } catch (error) {
        if (!isSyncStateUnreadable(error)) throw error;
        invalid = true;
        unreadable = true;
      }
      if (waiting && stored === null) {
        const since = new Date(options.clock.nowMs()).toISOString() as IsoDateTime;
        await writeJson(options.data.repos, META.waitingSince, since);
        return since;
      }
      if (!waiting && (stored !== null || invalid)) await writeJson(options.data.repos, META.waitingSince, null);
      return waiting ? stored : null;
    });
    publish(
      statusFromFacts(withoutCycleStart(status), result, {
        waitingSince: waitingSince === undefined ? (waiting ? (status.waitingSince ?? null) : null) : waitingSince,
        folderLabel: result.folderLabel ?? status.folderLabel,
        folderKind: result.folderKind ?? status.folderKind ?? null,
        lastSyncAt: result.lastSyncAt ?? status.lastSyncAt,
        conflictsThisWeek: conflicts,
        ...(reintegrationFailure === undefined ? {} : { reintegrationFailure }),
        ...(forget === undefined ? {} : { forget }),
        ...(reset === undefined ? {} : { reset }),
        stateUnreadable: unreadable || result.stateUnreadable === true,
        nowMs: options.clock.nowMs(),
      }),
    );
  };

  /** Y-11 : état de la réinitialisation relu de sync_meta et publié sans cycle (échec du lancement, visible aussitôt). */
  const refreshReset = async (): Promise<void> => {
    try {
      const reset = await readResetStatus(options.data.repos, options.clock.nowMs());
      const { reset: _previous, ...rest } = status;
      publish(reset ? { ...rest, reset } : rest);
    } catch (error) {
      // Valeur précédente gardée, `state-unreadable` visible aussitôt ; relue à la fin du prochain cycle.
      readFailed('reset', error);
      publish({ ...status, stateUnreadable: true });
    }
  };

  /** Y-10 : état de l'oubli relu de sync_meta et publié sans cycle (échec d'une déclaration, visible aussitôt). */
  const refreshForget = async (): Promise<void> => {
    try {
      const forget = await readForgetStatus(options.data.repos);
      const { forget: _previous, ...rest } = status;
      publish(forget ? { ...rest, forget } : rest);
    } catch (error) {
      // Valeur précédente gardée, `state-unreadable` visible aussitôt ; relue à la fin du prochain cycle.
      readFailed('forget', error);
      publish({ ...status, stateUnreadable: true });
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
      if (result.outcome === 'interrupted') {
        // ADR 0011 §22 point 6 : arrêt à l'échéance (iPhone passé en arrière-plan) : ni panne, ni bandeau ; l'état d'avant le cycle reste
        // affiché (heure de dernière synchro inchangée), le cycle d'ouverture suivant reprend.
        publish(withoutCycleStart({ ...before, progress: null }));
        return result;
      }
      await finish(result);
      return result;
    } catch (error) {
      // Code réel de l'erreur (`io` seulement à défaut) ; une valeur stockée illisible pose aussi `state-unreadable`.
      const code = syncErrorCodeOf(error);
      const unreadable = isSyncStateUnreadable(error);
      deps.logger.log('cycle-crashed', { code });
      publish({ ...omitKey(omitKey(before, 'errorStreak'), 'retryAt'), phase: 'error', errorCode: code, ...errorRepeat(before, code, options.clock.nowMs()), ...(unreadable ? { stateUnreadable: true } : {}) });
      return { outcome: 'failed', errorCode: code, pendingFiles: [], devices: [], keyMismatch: false, folderLabel: null, lastSyncAt: null, worked: false, ...(unreadable ? { stateUnreadable: true } : {}) };
    } finally {
      clearTimer(timer);
    }
  };

  /**
   * Y-11 : une réinitialisation trouvée en cours au démarrage (arrêt pendant l'annonce, l'ouverture ou la bascule) est marquée reprise
   * (`RESET_META`, écriture ordinaire de `sync_meta`). Un échec est visible (phase d'erreur), jamais seulement journalisé (revue 11).
   */
  const markResumed = async (): Promise<void> => {
    try {
      const stored = await readResetState(options.data.repos);
      if (stored && (stored.step === 'announced' || stored.step === 'snapshot' || stored.step === 'switching') && !stored.resumed) {
        await writeJson(options.data.repos, RESET_META, { ...stored, resumed: true });
        deps.logger.log('reset-resumed', { step: stored.step });
      }
    } catch (error) {
      deps.logger.log('reset-resume-unmarked', { code: syncErrorCodeOf(error) });
      publish({ ...status, phase: 'error', errorCode: syncErrorCodeOf(error) });
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
        (error: unknown) => {
          // Action en échec (lecture ou écriture de l'état local hors cycle) : journalisée et visible (`state-unreadable`).
          deps.logger.log('action-failed', { kind, code: syncErrorCodeOf(error) });
          signalFailure(error);
        },
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
    syncNow: (reason: SyncReason, syncOptions: SyncNowOptions = {}) => {
      // P-04-iOS (revue I3) : pendant la mise au calme d'une restauration, aucun cycle ne part, d'où que vienne la demande.
      if (isRestoreQuiet()) {
        deps.logger.log('sync-now-quiet', { reason });
        return Promise.resolve();
      }
      deps.logger.log('sync-now', { reason });
      // ADR 0011 §22 point 6 : seul le cycle `hide` est borné par une échéance ; une demande non bornée attendant avec lui la retire (un
      // cycle d'ouverture, périodique ou manuel n'est jamais coupé).
      const deadlineAt = reason === 'hide' ? syncOptions.deadlineAt : undefined;
      if (waiting.has('sync')) nextDeadline = deadlineAt === undefined ? undefined : nextDeadline === undefined ? undefined : deadlineAt;
      else nextDeadline = deadlineAt;
      return schedule('sync', () => {
        const at = nextDeadline;
        nextDeadline = undefined;
        return cycle(at === undefined ? {} : { deadlineAt: at, ...(options.deadlineProbe ? { deadlineProbe: options.deadlineProbe } : {}) });
      });
    },
    onRemoteChanges: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    async restoreContext() {
      try {
        return await loadRestoreContext();
      } catch (error) {
        // Revue, point 1 : journalisé et visible, puis rendu à l'appelant (jamais converti en « aucun marqueur »).
        deps.logger.log('restore-context-failed', { code: syncErrorCodeOf(error) });
        signalFailure(error);
        throw error;
      }
    },
    chooseRestoreOption: (option: RestoreOption) =>
      schedule('choice', async () => {
        /**
         * QA-1 (aucun échec silencieux) : un choix refusé (option retirée, §18 point 16) ou en échec est gardé dans `sync_meta`
         * (`restoreFailure`, montré par la fenêtre de choix jusqu'à un choix appliqué) et rendu visible aussitôt (phase d'erreur).
         */
        const failed = async (code: SyncErrorCode): Promise<void> => {
          try {
            await recordRestoreFailure(deps, option, code);
          } catch {
            deps.logger.log('restore-failure-unrecorded', { code });
          }
          publish({ ...status, phase: 'error', errorCode: code });
        };
        try {
          // Une erreur de lecture atteint `failed` (catch ci-dessous) : choix refusé de façon visible, jamais ignoré.
          const context = await loadRestoreContext();
          if (!context) return;
          if (!context.options.includes(option)) {
            deps.logger.log('restore-choice-refused', { option });
            await failed('state-mismatch');
            return;
          }
          deps.logger.log('restore-choice', { option });
          if (option === 'apply-everywhere') {
            await applyEverywhere(deps);
            await options.platform.restoreMarker.clear();
            await writeJson(options.data.repos, RESTORE_FAILURE_META, null);
            await cycle();
            return;
          }
          await prepareKeepSynced(deps);
          const result = await cycle({ ignoreMarker: true, forceResume: true });
          if (result.outcome !== 'done') {
            await failed(result.errorCode ?? 'io');
            return;
          }
          await options.platform.restoreMarker.clear();
          await writeJson(options.data.repos, RESTORE_FAILURE_META, null);
          await finish(result);
        } catch (error) {
          await failed(syncErrorCodeOf(error));
        }
      }),
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
    async startFromThisDevice(): Promise<void> {
      await schedule('choice', async () => {
        await writeJson(options.data.repos, META.startHere, true);
        await cycle();
      }).catch(() => undefined);
    },
    async fullResume(): Promise<void> {
      await schedule('choice', async () => {
        await writeJson(options.data.repos, META.orphanTraceAck, true);
        await cycle({ forceResume: true });
      }).catch(() => undefined);
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
    // Y-IOS-02 (point de contrôle d'Ali) : un appareil sans clé ne réinitialise jamais (nouvelle clé et nouvelle époque : les autres
    // appareils devraient tout recevoir de lui). Refus `key-missing` gardé et rendu, avant tout cycle et toute boîte native. Trousseau
    // illisible : son code réel (`vault-unavailable`), jamais lu comme « présente ».
    let keyPresent: boolean;
    try {
      keyPresent = (await options.platform.key.status()).present;
    } catch (error) {
      const code = syncErrorCodeOf(error);
      await recordResetFailure(deps, 'start', code);
      return { kind: 'failed', code };
    }
    if (!keyPresent) {
      deps.logger.log('reset-refused', { code: 'key-missing' });
      await recordResetFailure(deps, 'start', 'key-missing');
      return { kind: 'failed', code: 'key-missing' };
    }
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
