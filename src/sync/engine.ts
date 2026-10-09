import type { Repositories, SyncStateRow } from '../db/repositories';
import { isSyncStateUnreadable, parseStoredAcks, parseStoredOwnStateMarks, parseStoredResumeTried, parseStoredSegmentGaps, type StoredSegmentGap, type StoredStateLog } from '../domain/sync/stored';
import { DEVICE_EXPIRY_MS, MAX_STATE_ACKS, SNAPSHOT_INTERVAL_MS, SNAPSHOTS_KEPT_PER_EPOCH, STATE_REFRESH_MS, SYNC_FORMAT_MAJOR, STATE_FILE, compareEpochs, epochId, segmentFileName, type DeviceAck, type EpochId, type PublishedDeviceState, type RecordCursor } from '../domain/sync/format';
import { keyMismatchFromDevices } from '../domain/sync/devices';
import { canPublish, compareCursors, folderEpoch, isOrphanEpoch, maxEpoch, ownBounds, unreadableDevices } from '../domain/sync/epoch';
import { hlcDevice, hlcMs, publishedStateToText } from '../domain/sync/parse';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { syncErrorCodeOf, type DeviceScan, type FolderScan, type SyncFolderInfo, type SyncDeviceStatus, type SyncErrorCode } from '../platform/sync/types';
import type { ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { queueOwnRowsForRepublish, switchEpoch } from './epochSwitch';
import { maintain, retryParked } from './maintenance';
import { META, readJson, writeJson } from './meta';
import { AWAITING_ACK_SEQ, ackSeqAwaited, comparableState, deviceStatusOf } from '../domain/sync/ownState';
import { finishResumeTx, isJoining, joinFromSnapshot, triedTracker } from './join';
import { evaluateForget, finishRejoin, FORGET_META, forgetKnownDevices, forgetPublishPending, readForgetStatus, readLimit, rejoinPending, runForgetDeletions, setSnapshotWait, type ForgetView } from './forget';
import { pickEligible, readSnapshotEnd, snapshotCandidates, type ForgetCoverage } from './eligible';
import { addOwnStateMark, decideSegmentGap, type ResumeTried, type SnapshotRef, coversForgotten, eligibleSnapshot, purgeExplainsMissingSegment, forgetGaps, type OwnStateMark, forgetOrder, forgottenDeleteCheck, publishedEpochs, snapshotInEpoch, withoutStaleAcks, type SnapshotEndRead } from '../domain/sync/retention';
import { publishOutbox, readInflight } from './publisher';
import { storedDeviceStatuses } from './deviceStatus';
import { readDevice } from './reader';
import { loadSnapshot, mergeSnapshot, snapshotPages } from './snapshot';
import { allowedSwitchTarget, clearResetFailure, evaluateReset, noticeToPublish, openResetEpoch, recordResetFailure, republishWithoutNotice, resetActive, resetLagging, type ResetDirective } from './reset';
import type { CycleFacts } from './status';
import { createCycleDeadline, isCycleInterrupted, type DeadlineUnit } from './deadline';
import { scanWarnings, type SyncWarningCode } from '../domain/syncBanners';

/**
 * Cycle de synchronisation (ADR 0011, section 10.2 ; Y-02 critère 3) : 0 préconditions, 1 `scan({ keep })`, 2 règle 1, 3 époque,
 * 4 lecture, 5 publication, 6 `writeState` si l'état a changé, 7 entretien, 8 heure de dernière synchro (et `onRemoteChanges`, émis
 * après chaque lot appliqué). Ne rejette jamais : le résultat est un constat (`CycleFacts`) dont `status.ts` tire la phase affichée.
 */

export interface CycleHooks {
  readonly onRemoteChanges: (touched: ReadonlyMap<string, ReadonlySet<string>>) => void;
  /** Le cycle lit ou écrit (bandeau « Synchro en cours », A-09). */
  readonly onWork?: () => void;
  readonly onProgress?: (done: number, total: number) => void;
}

export interface CycleOptions {
  /** Choix « Garder les données synchronisées » en cours : le marqueur ne bloque pas ce cycle, la reprise est forcée. */
  readonly ignoreMarker?: boolean;
  readonly forceResume?: boolean;
  /** Y-11 : calculer à la fin du cycle la précondition de la réinitialisation (« Synchronisez d'abord »). */
  readonly resetCheck?: boolean;
  /**
   * ADR 0011 §22 point 6 : échéance du cycle `hide` de l'iPhone (horloge injectée, ms), comparée avant chaque unité atomique ; atteinte, le
   * cycle s'arrête (issue `interrupted`) : file gardée, aucun cycle complet marqué, aucune erreur.
   */
  readonly deadlineAt?: number;
  /** Tests : appelé avant chaque comparaison à l'échéance (arrêt à une frontière choisie). */
  readonly deadlineProbe?: (unit: DeadlineUnit) => void;
}

export interface CycleResult extends CycleFacts {
  readonly folderLabel: string | null;
  readonly folderKind?: SyncFolderInfo['kind'] | null;
  readonly lastSyncAt: IsoDateTime | null;
  readonly worked: boolean;
  /** Y-11 (`resetCheck`) : premier appareil pas encore lu jusqu'à sa tête (null : la réinitialisation peut commencer). */
  readonly resetLag?: ReturnType<typeof resetLagging>;
}

const EMPTY: Omit<CycleResult, 'outcome'> = { errorCode: null, pendingFiles: [], devices: [], keyMismatch: false, folderLabel: null, folderKind: null, lastSyncAt: null, worked: false };

const ZERO: RecordCursor = { segment: 0, record: 0 };

export const iso = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

function acksToJson(acks: ReadonlyMap<DeviceId, DeviceAck>): string {
  const out: Record<string, DeviceAck> = {};
  for (const [id, ack] of acks) out[id] = ack;
  return JSON.stringify(out);
}

/** Accepte les états authentifiés des autres appareils dans `sync_state` (anti-rejeu local, section 1.4). */
async function acceptStates(deps: SyncDeps, scan: FolderScan, known: Map<string, SyncStateRow>, forgottenNow: ReadonlyMap<DeviceId, { readonly by: DeviceId }>, gaps: ReadonlyMap<DeviceId, StoredSegmentGap>): Promise<Map<DeviceId, PublishedDeviceState>> {
  const accepted = new Map<DeviceId, PublishedDeviceState>();
  for (const device of scan.devices) {
    if (device.deviceId === deps.deviceId) continue;
    const previous = known.get(device.deviceId);
    // Y-10 (§18 point 12) : le statut `forgotten` suit l'ordre total de la liste maître à chaque scan (un oubli annulé redevient actif).
    let status = forgottenNow.has(device.deviceId) ? 'forgotten' : deviceStatusOf(device, previous?.status === 'forgotten' ? undefined : previous?.status);
    if (status === 'forgotten' && previous?.status !== 'forgotten') deps.logger.log('forget-applied', { device: device.deviceId, by: forgottenNow.get(device.deviceId)?.by ?? null });
    const state = device.stateStatus === 'ok' ? device.state : null;
    if (state) {
      const text = publishedStateToText(state);
      const rollback =
        previous !== undefined &&
        previous.stateSeq > 0 &&
        (state.stateSeq < previous.stateSeq || (state.stateSeq === previous.stateSeq && previous.stateDigest !== null && previous.stateDigest !== text) || (previous.stateEpoch !== null && compareEpochs(state.epoch, previous.stateEpoch as EpochId) < 0));
      if (rollback) {
        // État rejoué : refusé (non accepté) ; un appareil oublié le reste (Y-10).
        if (status !== 'forgotten') status = 'rollback';
      } else {
        if (status === 'forgotten') {
          // Y-10 : état gardé (ses accusés et ses déclarations comptent pour l'ordre total), statut inchangé.
        } else if (hlcMs(state.lastSyncHlc) < deps.clock.nowMs() - DEVICE_EXPIRY_MS) status = 'expired';
        // Corruption au milieu d'un segment sans instantané plus récent : l'appareil reste `corrupt` tant que sa tête ne bouge pas (section 5.5).
        else if (previous?.status === 'corrupt' && previous.headSegment === state.head.segment && previous.headRecord === state.head.record && previous.stateEpoch === state.epoch) status = 'corrupt';
        // Quatrième revue, point B : trou mémorisé dans l'époque de l'état : `corrupt` gardé même si la tête bouge (seule la règle du trou le retire).
        else if (gaps.get(device.deviceId)?.epoch === state.epoch) status = 'corrupt';
        accepted.set(device.deviceId, state);
        await deps.data.repos.sync.saveState(device.deviceId, {
          platform: state.platform,
          appVersion: state.appVersion,
          headSegment: state.head.segment,
          headRecord: state.head.record,
          headHlc: state.head.hlc,
          stateEpoch: state.epoch,
          stateSeq: state.stateSeq,
          stateDigest: text,
          lastAcks: acksToJson(state.acks),
          lastSeenHlc: state.lastSyncHlc,
          schemaVersion: state.sv,
          formatMajor: state.sm,
          kid: device.kid,
          purgeHorizon: state.purgeHorizon,
          snapshotSeq: state.snapshot?.seq ?? null,
          snapshotHlc: state.snapshot?.endHlc ?? null,
          status,
        });
        continue;
      }
    }
    await deps.data.repos.sync.saveState(device.deviceId, { status, ...(device.kid ? { kid: device.kid } : {}) });
  }
  return accepted;
}

/** Résout une intention d'ajout interrompue (arrêt entre l'ajout et le retrait de la file) : hypothèse « ajout réussi » d'abord. */
async function resolveInflight(deps: SyncDeps, writeOwnState: (head: DeviceAck) => Promise<boolean>): Promise<void> {
  const inflight = await readInflight(deps.data.repos);
  if (!inflight) return;
  const head: DeviceAck = { epoch: inflight.epoch, segment: inflight.segment, record: inflight.expect + inflight.count, hlc: inflight.maxHlc, stateSeq: 0 };
  const ok = await writeOwnState(head);
  await deps.data.transaction(async (repos) => {
    if (ok) {
      await repos.sync.clearPublished(inflight.entries);
      await writeJson(repos, META.head, head);
    }
    await writeJson(repos, META.inflight, null);
  });
  deps.logger.log('inflight-resolved', { appended: ok });
}

/**
 * Un cycle (voir le module). Y-TECH-02 : les avertissements du scan sont joints au résultat dès que le scan a réussi (même si le cycle
 * échoue ensuite) ; une valeur stockée illisible (`SyncStateUnreadableError`) donne `stateUnreadable` (§19 point 7), jamais « aucune ».
 */
export async function runCycle(baseDeps: SyncDeps, hooks: CycleHooks, options: CycleOptions = {}): Promise<CycleResult> {
  const seen: CycleSeen = {};
  const deadline = options.deadlineAt === undefined ? undefined : createCycleDeadline(baseDeps.clock, options.deadlineAt, options.deadlineProbe);
  const deps: SyncDeps = deadline ? { ...baseDeps, deadline } : baseDeps;
  let result: CycleResult;
  try {
    result = await cycleSteps(deps, hooks, options, seen);
  } catch (error) {
    // ADR 0011 §22 point 6 : arrêt à l'échéance, entre deux unités : la file garde ce qui n'est pas publié, `lastSyncAt` n'avance pas,
    // aucune phase d'erreur ; le cycle d'ouverture suivant reprend (journal du code seulement).
    if (isCycleInterrupted(error)) {
      deps.logger.log('cycle-interrupted', { unit: error.unit });
      return { ...EMPTY, outcome: 'interrupted' };
    }
    // Lecture hors des étapes gardées : seule l'illisibilité est convertie ici ; toute autre erreur remonte au service (code réel).
    if (!isSyncStateUnreadable(error)) throw error;
    deps.logger.log('cycle-failed', { code: 'io', unreadable: true });
    result = { ...EMPTY, outcome: 'failed', errorCode: 'io', stateUnreadable: true };
  }
  const withWarnings = seen.warnings ? { ...result, warnings: [...new Set(seen.warnings)] } : result;
  // Cinquième revue, points 2 et 5 : valeur locale illisible relue vide et réécrite pendant ce cycle : visible pour ce cycle seulement.
  return seen.unreadable ? { ...withWarnings, stateUnreadable: true } : withWarnings;
}

async function cycleSteps(deps: SyncDeps, hooks: CycleHooks, options: CycleOptions, seen: CycleSeen): Promise<CycleResult> {
  const { platform, data, deviceId: self, logger } = deps;
  const repos = data.repos;
  let worked = false;
  const work = (): void => {
    if (!worked) hooks.onWork?.();
    worked = true;
  };
  const fail = (code: SyncErrorCode, extra: Partial<CycleResult> = {}): CycleResult => {
    logger.log('cycle-failed', { code });
    return { ...EMPTY, ...extra, outcome: 'failed', errorCode: code, worked };
  };
  /** Échec d'une étape : code réel, et `stateUnreadable` pour une valeur stockée illisible ; un arrêt à l'échéance n'est pas un échec. */
  const failWith = (error: unknown, extra: Partial<CycleResult> = {}): CycleResult => {
    if (isCycleInterrupted(error)) throw error;
    return fail(syncErrorCodeOf(error), isSyncStateUnreadable(error) ? { ...extra, stateUnreadable: true } : extra);
  };

  // 0. Préconditions.
  if (!platform.available()) return { ...EMPTY, outcome: 'not-configured' };
  let folderLabel: string | null = null;
  let folderKind: SyncFolderInfo['kind'] | null = null;
  /** Y-11 : `kid` de la clé locale et de la nouvelle clé (`.next`), dernier refus d'import ; jamais une clé. */
  let keyStatus!: Awaited<ReturnType<SyncDeps['platform']['key']['status']>>;
  /**
   * Y-IOS-02 (point de contrôle d'Ali, 0.2.1) : lecture de l'état local (reprise de « Associer de nouveau », identité) en échec (base
   * occupée…). Elle ne masque jamais l'absence de clé : un appareil sans clé reste « à associer » (phase `needs-pairing`, état local
   * illisible signalé à part), jamais une erreur générique qui retirerait « Associer au PC » et relancerait des cycles sans issue.
   */
  let localFailure: unknown = null;
  try {
    // Y-10 (D2) : « Associer de nouveau » interrompu avant que le dossier soit délié : terminé avant tout autre appel.
    if (await rejoinPending(repos)) {
      const rejoined = await finishRejoin(deps);
      if (rejoined.kind === 'failed') return fail(rejoined.code as SyncErrorCode);
    }
    // Y-10 (revue, point 2) : « Associer de nouveau » a changé l'identité de l'appareil ; tant que l'app n'est pas relancée, ce service
    // (ancienne identité) ne fait plus aucun cycle : il ne lierait jamais l'ancien identifiant à un dossier choisi de nouveau.
    const storedId = await repos.settings.get('device.id');
    if (storedId !== null && storedId !== self) {
      logger.log('restart-required', {});
      return { ...EMPTY, outcome: 'restart-required' };
    }
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    localFailure = error;
  }
  try {
    const folder = await platform.folder.info();
    if (!folder.configured) return localFailure === null ? { ...EMPTY, outcome: 'not-configured' } : failWith(localFailure);
    folderLabel = folder.label;
    folderKind = folder.kind;
    // Clé absente (`present` faux) : à associer. Trousseau ou coffre illisible (iPhone verrouillé) : `vault-unavailable` (rejet ci-dessous),
    // jamais lu comme « absente ».
    const key = await platform.key.status();
    keyStatus = key;
    if (!key.present) {
      if (localFailure !== null) logger.log('state-read-failed', { what: 'preconditions', code: syncErrorCodeOf(localFailure) });
      return { ...EMPTY, folderLabel, folderKind, outcome: 'needs-pairing', ...(localFailure !== null ? { stateUnreadable: true } : {}) };
    }
    if (localFailure !== null) return failWith(localFailure, { folderLabel, folderKind });
    if (!options.ignoreMarker && (await platform.restoreMarker.get())) return { ...EMPTY, folderLabel, folderKind, outcome: 'restore-choice' };
    await platform.bindDevice(self);
  } catch (error) {
    return failWith(error, { folderLabel, folderKind });
  }

  // 1. scan.
  // Cinquième revue, point 2 : trous et instantané essayé lus avant les lignes connues (une valeur illisible remet les lignes `corrupt`
  // à `active` avant l'acceptation des états).
  const segmentGaps = await readSegmentGaps(deps, seen);
  /** Cinquième revue, point 1 : dernier instantané essayé par une reprise (`sync_meta.resumeTried`). */
  let resumeTried: ResumeTried | null = await readResumeTried(deps, seen);
  // Cinquième revue, point 5 : repères lus au début du cycle ; illisibles : visibles pour ce cycle, réécrits vides aussitôt.
  await checkOwnStateMarks(deps, seen);
  const known = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
  let scan: FolderScan;
  // ADR 0011 §22 points 4 et 6 : cycle borné : scan seulement avant l'échéance, hydratation bornée par elle (moins 2 s).
  deps.deadline?.check('scan');
  try {
    const keep = [...known.keys()].filter((id) => id !== self) as DeviceId[];
    scan = await platform.scan(deps.deadline ? { keep, hydrateBudgetMs: deps.deadline.hydrateBudgetMs() } : { keep });
  } catch (error) {
    return failWith(error, { folderLabel, folderKind });
  }
  seen.warnings = scanWarnings(scan);
  if (seen.warnings.length > 0) logger.log('scan-warnings', { codes: seen.warnings.join(',') });
  await repos.sync.saveState(self, { isSelf: true, platform: deps.devicePlatform, appVersion: deps.appVersion, status: 'active' });
  const accepted = await acceptStates(deps, scan, known, forgetOrder(scan.forgotten.entries), segmentGaps);
  const ownScan = scan.devices.find((d) => d.deviceId === self) ?? null;
  const ownState = ownScan?.stateStatus === 'ok' ? ownScan.state : null;
  const pending = new Set<string>(scan.devices.flatMap((d) => d.pending.map((p) => `${String(d.deviceId).slice(0, 8)}/${p.file}`)));
  /** Fichiers listés « dans le nuage » par le scan, élagués après la lecture (revue Y-IOS, QA : voir `pruneUnneeded`). */
  const scanPending = scan.devices.flatMap((d) => d.pending.map((p) => ({ deviceId: d.deviceId, file: p.file, key: `${String(d.deviceId).slice(0, 8)}/${p.file}` })));

  // Y-10 : ordre total des oublis (déclarations des seuls états authentifiés). Appareil local oublié : il ne lit ni ne publie plus.
  let forgetView: ForgetView;
  try {
    forgetView = await evaluateForget(deps, { registry: scan.forgotten, rows: await repos.sync.getStates(), previousRows: [...known.values()] });
  } catch (error) {
    return failWith(error, { folderLabel, folderKind });
  }
  if (forgetView.selfForgotten) {
    logger.log('forgotten-self', { by: forgetView.order.get(self)?.by ?? null });
    return { ...EMPTY, outcome: 'forgotten', folderLabel, folderKind, devices: await deviceStatuses(repos, self, accepted, deps.sv, logger) };
  }
  // Y-10 : un appareil oublié ne compte pas pour « aucun appareil ne partage la clé ».
  const keyMismatch = keyMismatchFromDevices(scan.devices.filter((d) => !forgetView.order.has(d.deviceId)).map((d) => ({ self: d.deviceId === self, foreign: d.stateStatus === 'foreign' })));

  // Y-11 (§14.3, §18 point 2) : réinitialisation vue par Rust (rôle, étape, perte, bascule) ; annonce authentique d'un autre appareil :
  // publication suspendue (file gardée, rien n'est écrit), phase `reset-required` ; perdant : son état sous l'ancienne clé republié une fois.
  let resetDirective: ResetDirective;
  try {
    resetDirective = await evaluateReset(deps, { scan, known, accepted, forget: forgetView, key: keyStatus });
    if (resetDirective.kind === 'required') {
      // §18 point 14 : journaux suspendus, mais son état sous la clé locale est republié (même époque, sans ajout) chaque fois que sa
      // liste maître grandit : une déclaration d'oubli n'attend jamais la fin d'une suspension.
      const masterGrew = ownState !== null && forgetView.master.length > ownState.forgotten.length;
      if (resetDirective.republish || masterGrew) await republishWithoutNotice(deps, ownState, forgetView.master);
      logger.log('publish-suspended', { reason: 'reset-required' });
      return { ...EMPTY, outcome: 'reset-required', folderLabel, folderKind, keyMismatch: false, devices: await deviceStatuses(repos, self, accepted, deps.sv, logger), pendingFiles: [...pending] };
    }
  } catch (error) {
    return failWith(error, { folderLabel, folderKind });
  }
  const directive = resetDirective;

  // 2. Règle 1 : bornes de sa propre publication.
  const acksOnSelf = [...accepted.values()].map((s) => s.acks.get(self)).filter((a): a is DeviceAck => a !== undefined);
  let localEpoch = await readJson<EpochId>(repos, META.epoch);
  const localSeq = (await readJson<number>(repos, META.stateSeq)) ?? 0;
  const pairedBy = ownState?.pairedBy;
  let stateSeq = Math.max(localSeq, ownState?.stateSeq ?? 0, ...acksOnSelf.map((a) => a.stateSeq));
  const lastStateMeta = await readJson<{ text: string; at: number }>(repos, META.lastState);

  const buildState = (epoch: EpochId, head: DeviceAck, seq: number, snapshot: { seq: number; endHlc: Hlc } | null, purgeHorizon: Hlc | null, acks: Map<DeviceId, DeviceAck>): PublishedDeviceState => ({
    deviceId: self,
    platform: deps.devicePlatform,
    appVersion: deps.appVersion,
    sm: SYNC_FORMAT_MAJOR,
    sv: deps.sv,
    epoch,
    stateSeq: seq,
    head: { ...head, epoch, stateSeq: seq },
    acks,
    snapshot,
    purgeHorizon,
    lastSyncHlc: deps.hlc.now(),
    ...(pairedBy ? { pairedBy } : {}),
    // Y-10 (§18 point 3) : chaque appareil republie la liste maître entière rendue par le scan (Rust complète ce qu'il a appris depuis).
    forgotten: [...forgetView.master],
    // Y-11 : annonce de l'appareil qui réinitialise, sous l'ancienne clé (maître : Rust, qui la refuse si elle diffère de la sienne).
    reset: noticeToPublish(directive, epoch),
  });

  /**
   * Y-TECH-01 : appareils dont l'état n'est pas lisible à ce scan (`ackSeqAwaited`) ; un état `ok` au scan mais refusé par l'anti-rejeu
   * local est un état rejoué.
   */
  const awaitingAckSeq = new Set(scan.devices.filter((d) => d.deviceId !== self && (AWAITING_ACK_SEQ.has(d.stateStatus) || (d.stateStatus === 'ok' && !accepted.has(d.deviceId)))).map((d) => d.deviceId));
  /** Y-10 : déclaration confirmée à publier (intention posée avant l'appel à Rust). */
  let publishForget = await forgetPublishPending(repos);
  /** Dernier état écrit dans ce cycle (suppression des fichiers d'un appareil oublié : Rust relit son état sur le disque). */
  let lastWritten: PublishedDeviceState | null = null;

  /** Écrit son `state.ctx` ; renvoie faux sur `state-mismatch` (hypothèse refusée par Rust). */
  const writeState = async (state: PublishedDeviceState, force: boolean): Promise<boolean> => {
    const comparable = comparableState(state);
    if (state.acks.size > MAX_STATE_ACKS) {
      // Plus de 64 accusés (oublis retenus au-delà des places, §14.2) : état refusé par Rust ; rien publié, « oubli en échec ».
      logger.log('acks-overflow', { count: state.acks.size });
      await recordForgetOverflow(deps);
      return false;
    }
    // Y-TECH-01 : le `stateSeq` des accusés n'entre pas dans la comparaison (`comparableState`) ; il est republié avec toute autre
    // modification ou au rafraîchissement de 30 minutes, et **aussitôt** sur un appareil dont l'état est absent, étranger, illisible ou
    // rejoué : c'est la borne qu'il attend pour republier (règle 1, reconstruction (iii) de `forgotten.json`).
    const forced = force || publishForget || ackSeqAwaited(state, lastWritten ?? ownState, awaitingAckSeq);
    if (!forced && lastStateMeta && lastStateMeta.text === comparable && deps.clock.nowMs() - lastStateMeta.at < STATE_REFRESH_MS && ownState !== null) return true;
    deps.deadline?.check('write-state');
    try {
      await platform.writeState({ sv: deps.sv, state });
      stateSeq = state.stateSeq;
      await data.transaction(async (tx) => {
        await writeJson(tx, META.stateSeq, state.stateSeq);
        await writeJson(tx, META.lastState, { text: comparable, at: deps.clock.nowMs() });
        // Quatrième revue, point D (§5.5, condition 3) : repère de cet état publié ; une liste illisible (journalisée) est réécrite.
        await writeJson(tx, META.ownStateHlcs, addOwnStateMark(await readOwnStateMarks(tx, logger), state.stateSeq, state.lastSyncHlc, deps.clock.nowMs()));
        if (publishForget) await writeJson(tx, FORGET_META.publish, null);
      });
      if (publishForget) logger.log('forget-published', {});
      publishForget = false;
      lastWritten = state;
      work();
      return true;
    } catch (error) {
      const code = syncErrorCodeOf(error);
      logger.log('write-state-failed', { code });
      if (code === 'state-mismatch') return false;
      throw error;
    }
  };

  // Horloge locale : jamais en dessous de sa propre tête publiée (après contrôle de dérive implicite : c'est son propre hlc).
  if (ownState?.head.hlc) deps.hlc.receive(ownState.head.hlc);

  try {
    // 3. Époque.
    // Y-10 (seconde revue, point 1) : un appareil oublié ne fixe ni l'époque du dossier, ni la date du dernier instantané, ni la source d'un
    // changement d'époque (son état reste accepté pour les curseurs et la coupure).
    const live = new Map([...accepted].filter(([id]) => !forgetView.order.has(id)));
    const states = [...live.values()];
    /** Liste maître et accusés des actifs (le sien compris) : coupures, instantanés éligibles, trous (§18 point 11). */
    // Y-11 (remarques finales) : un accusé après la dernière époque publiée par sa cible (état accepté) ne compte dans aucune coupure
    // (même filtre que Rust, table `reset-order.json`).
    const published = (own: PublishedDeviceState | null) => publishedEpochs([...accepted.values(), ...(own ? [own] : [])]);
    const coverage = (): ForgetCoverage => {
      const own = lastWritten ?? ownState;
      return { master: forgetView.master, ackers: withoutStaleAcks([...live.values(), ...(own ? [own] : [])], published(own)), forgotten: forgetView.order };
    };
    const folderE = folderEpoch([...states, ...(ownState ? [ownState] : [])]);
    // Y-IOS-02 (ADR 0011 §24 point 1) : un appareil qui n'a suivi aucune époque ne se tient pas pour le premier tant qu'un autre appareil non
    // oublié a des fichiers que ce scan ne peut pas encore lire (état dans le nuage, illisible, époques sans état, fichiers en attente).
    const unreadable = unreadableDevices(scan.devices, self, forgetView.order, [...(keyStatus.pairedBy ? [keyStatus.pairedBy] : []), ...known.keys()] as DeviceId[]);
    /** Attente visible qui nomme l'appareil (fantôme « jamais vu » dans APPAREILS, où « Oublier l'appareil » est la seule issue). */
    const waitForUnreadable = async (event: string): Promise<CycleResult> => {
      for (const d of unreadable) {
        pending.add(`${String(d.deviceId).slice(0, 8)}/${STATE_FILE}`);
        logger.log(event, { device: d.deviceId, state: d.stateStatus });
      }
      const devices = withUnseenDevices(await deviceStatuses(repos, self, accepted, deps.sv, logger), scan, self, unreadable.map((d) => d.deviceId));
      return { ...EMPTY, outcome: 'done', pendingFiles: [...pending], folderLabel, folderKind, worked, devices, keyMismatch };
    };
    /** Époque orpheline (§24 point 2) : preuve locale, recontrôlée par Rust à l'abandon. */
    const storedOwnSnapshot = await readJson<{ epoch: EpochId; seq: number }>(repos, META.snapshot);
    const orphanProof = isOrphanEpoch({
      epoch: localEpoch,
      ownStateOk: ownState !== null,
      ownStateStatus: ownScan?.stateStatus,
      acksOnSelf: acksOnSelf.length,
      localStateSeq: localSeq,
      storedSnapshot: storedOwnSnapshot,
      ownEpochs: ownScan?.epochs ?? [],
    });
    /** Époque orpheline déjà abandonnée dont les fichiers restent à supprimer (`sync_meta.orphanEpoch`, §24 point 4 (e)). */
    let orphanLeft = (await readJson<{ epoch: EpochId }>(repos, META.orphanEpoch))?.epoch ?? null;
    if (orphanProof && localEpoch !== null && folderE !== null && folderE !== localEpoch) {
      // (ii) Une autre époque existe (celle du PC, qui détient les données) : abandon de la sienne, jamais annoncée. Étapes idempotentes.
      work();
      const orphan = localEpoch;
      // (a) lignes remises dans la file d'envoi (elle avait été vidée à l'ouverture de l'orpheline), puis intention mémorisée.
      const queued = await queueOwnRowsForRepublish(deps);
      // Traces purgées dans l'orpheline (auteur cet appareil) : mémorisées pour la garde `orphan-trace-hit` de la reprise (§24 point 4 (a)).
      const traces: string[] = [];
      for (let after: { table: string; rowId: string } | null = null; ; ) {
        const page = await repos.sync.exportTombstones(after, 500);
        if (page.length === 0) break;
        const last = page[page.length - 1] as { table: string; rowId: string };
        after = { table: last.table, rowId: last.rowId };
        for (const tomb of page) if (hlcDevice(tomb.deletedHlc) === self) traces.push(`${tomb.table}|${tomb.rowId}`);
      }
      await writeJson(repos, META.orphanTraces, traces.length > 0 ? traces : null);
      await writeJson(repos, META.orphanEpoch, { epoch: orphan });
      deps.deadline?.check('append');
      // (b) `own.json` sans époque (Rust recontrôle la preuve). `state-mismatch` : preuve refusée, rien n'est écrit, l'abandon est annulé
      // (journal, et l'appareil le dit : `publish-blocked`) ; toute autre erreur est transitoire : cycle en échec visible, étape reprise.
      let refused = false;
      try {
        await platform.abandonOrphanEpoch(orphan);
      } catch (error) {
        if (isCycleInterrupted(error)) throw error;
        const code = syncErrorCodeOf(error);
        logger.log('orphan-epoch-abandon-failed', { code });
        if (code !== 'state-mismatch') return fail(code, { folderLabel, folderKind });
        refused = true;
        await writeJson(repos, META.orphanEpoch, null);
      }
      if (!refused) {
        // (c) transaction locale : l'appareil n'a plus d'époque suivie ; la reprise en fusion (branche « nouvel appareil ») suit.
        await data.transaction(async (tx) => {
          await writeJson(tx, META.epoch, null);
          await writeJson(tx, META.head, null);
          await writeJson(tx, META.snapshot, null);
          await writeJson(tx, META.lastState, null);
          await writeJson(tx, META.resume, true);
          await tx.sync.saveState(self, { epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
        });
        localEpoch = null;
        orphanLeft = orphan;
        logger.log('epoch-abandoned', { epoch: orphan, rows: queued });
      }
    } else if (orphanProof && folderE === null && unreadable.length > 0) {
      // (iii) rien ne dit si l'autre appareil a une époque : attente visible.
      return waitForUnreadable('orphan-epoch-waiting');
    }
    let epoch = localEpoch;
    let resume = options.forceResume === true || (await readJson<boolean>(repos, META.resume)) === true;
    const selfRow = known.get(self);
    if (selfRow?.lastSyncAt && Date.parse(selfRow.lastSyncAt) < deps.clock.nowMs() - DEVICE_EXPIRY_MS) resume = true;

    // Y-11 (§18 point 16) : pendant une réinitialisation, aucune autre époque que celle désignée par Rust (époque visée, ou époque
    // restaurée gagnante) n'est suivie.
    const allowed = allowedSwitchTarget(directive);
    const storedSwitch = await readJson<{ target: EpochId }>(repos, META.epochSwitch);
    const switchState = storedSwitch && (allowed === undefined || storedSwitch.target === allowed) ? storedSwitch : null;
    const followable = (e: EpochId | null): EpochId | null => (e === null || allowed === undefined || e === allowed ? e : null);
    if (allowed !== undefined && folderE !== null && folderE !== allowed && epoch !== null && compareEpochs(folderE, epoch) > 0) logger.log('epoch-not-followed', { epoch: folderE });
    if (epoch === null && folderE === null && unreadable.length > 0) return waitForUnreadable('epoch-open-deferred');
    // Y-IOS-02 (ADR 0011 §24 point 1) : une clé **importée** (QR ou clé de secours, `sync/key-origin.json`) ne fait jamais d'un appareil le premier :
    // tant qu'aucun état d'un autre appareil n'a été lu, quoi que montre le listing, il attend (sans nommer d'appareil) ; l'action explicite
    // « Démarrer la synchro depuis cet appareil » (`sync_meta.startHere`) lève l'attente.
    if (epoch === null && folderE === null && keyStatus.imported === true && live.size === 0 && (await readJson<boolean>(repos, META.startHere)) !== true) {
      logger.log('epoch-open-deferred', { reason: 'imported-key' });
      seen.warnings = [...(seen.warnings ?? []), 'awaiting-other-devices'];
      return { ...EMPTY, outcome: 'done', folderLabel, folderKind, worked, devices: await deviceStatuses(repos, self, accepted, deps.sv, logger), keyMismatch };
    }
    if (epoch === null && folderE === null) {
      // Premier appareil : ouverture de l'époque 1 (instantané complet, puis état).
      epoch = epochId(1, self);
      work();
      const maxSeq = await repos.sync.maxOutboxSeq();
      const endHlc = deps.hlc.now();
      // Revue : l'instantané est une seule unité (de `begin` à `commit`), jamais coupé entre deux pages.
      deps.deadline?.check('snapshot');
      await platform.writeSnapshot({ epoch, seq: 1, sv: deps.sv, records: snapshotPages(repos, epoch, new Map<DeviceId, DeviceAck>(), deps.sv) });
      const head: DeviceAck = { epoch, segment: 0, record: 0, hlc: null, stateSeq: 0 };
      await data.transaction(async (tx) => {
        await tx.sync.clearOutbox(maxSeq);
        await writeJson(tx, META.epoch, epoch);
        await writeJson(tx, META.head, head);
        await writeJson(tx, META.snapshot, { epoch, seq: 1, endHlc });
        await writeJson(tx, META.startHere, null);
      });
      logger.log('epoch-opened', { epoch });
    } else if (epoch === null && folderE !== null) {
      // Nouvel appareil (ou dossier retrouvé) : reprise depuis l'instantané en fusion. La reprise est mémorisée dans la même transaction
      // que l'époque : un arrêt avant sa fin la relance au cycle suivant (sinon l'époque connue ferait lire les journaux sans l'instantané).
      const opened = folderE;
      epoch = opened;
      await data.transaction(async (tx) => {
        await writeJson(tx, META.resume, true);
        await writeJson(tx, META.epoch, opened);
        await writeJson(tx, META.head, { epoch: opened, segment: 0, record: 0, hlc: null, stateSeq: 0 } satisfies DeviceAck);
      });
      resume = true;
    } else if (epoch !== null && ((followable(folderE) !== null && compareEpochs(folderE as EpochId, epoch) > 0) || switchState)) {
      const target = switchState?.target ?? (folderE as EpochId);
      work();
      // Y-11 (§9.1 b, §18 point 16 complément 2) : époque d'une réinitialisation (rejointe, ou la sienne retrouvée après une restauration)
      // atteinte par fusion seulement depuis l'époque de l'annonce (`n`) ; depuis toute autre époque, par remplacement. L'instantané doit
      // couvrir chaque oublié retenu jusqu'à sa coupure (accusés des actifs sous les deux clés, positions de l'époque `n`).
      const inReset = directive.kind === 'joined' || directive.kind === 'initiator';
      const merge = inReset && (directive.view.noticeEpoch ?? null) === epoch;
      const switched = await switchEpoch(deps, target, live, ownState, hooks.onRemoteChanges, {
        mode: merge ? 'merge' : 'replace',
        knows: await knowsFrom(repos, logger),
        forgotten: new Set(forgetView.order.keys()),
        coverage: { master: forgetView.master, ackers: withoutStaleAcks([...live.values(), ...(ownState ? [ownState] : [])], published(ownState)) },
      });
      if (switched !== 'done') {
        if (switched === 'cloud-pending') pending.add(`${target}/snapshot`);
        // §18 point 14 : réassocié sans instantané couvrant de l'appareil qui réinitialise : attente visible, réessayée à chaque cycle.
        if (switched === 'uncovered' && inReset) await recordResetFailure(deps, directive.kind === 'joined' ? 'joined' : 'waiting-devices', 'state-mismatch');
        // 'clock-ahead' : l'ouvreur est signalé (phase « horloge en avance »), le changement attend que la condition cesse ; 'uncovered' :
        // attente visible d'un instantané couvrant (Y-10 « aucun instantané à jour »).
        const waiting = switched === 'cloud-pending' || switched === 'clock-ahead' || switched === 'uncovered';
        return { ...EMPTY, outcome: waiting ? 'done' : 'failed', errorCode: waiting ? null : 'io', pendingFiles: [...pending], folderLabel, folderKind, worked, devices: await deviceStatuses(repos, self, accepted, deps.sv, logger) };
      }
      if (inReset) await clearResetFailure(deps, directive.kind === 'joined' ? 'joined' : 'waiting-devices', 'state-mismatch');
      epoch = target;
      resume = false;
    }
    const currentEpoch = epoch as EpochId;

    // Règle 1 (suite) : tête et segment maximal dans l'époque courante.
    const listed = ownScan?.epochs.find((e) => e.epoch === currentEpoch);
    const localHead = await readJson<DeviceAck>(repos, META.head);
    const bounds = ownBounds({
      epoch: currentEpoch,
      local: { epoch: localEpoch, stateSeq, head: localHead },
      published: ownState,
      acksOnSelf,
      listedMaxSegment: Math.max(0, ...(listed?.segments ?? [])),
    });
    stateSeq = bounds.nextStateSeq - 1;
    const storedSnapshot = await readJson<{ epoch: EpochId; seq: number; endHlc: Hlc }>(repos, META.snapshot);
    /**
     * Y-IOS-02 (point de contrôle 0.2.3, étape 4) : époque ouverte par cet appareil dont l'état n'a jamais été écrit (arrêt entre
     * l'instantané et l'état : échéance du cycle `hide` de l'iPhone, erreur d'écriture). Preuve locale : son propre instantané est le seul
     * fichier listé, aucun segment, `stateSeq` jamais écrit, aucun accusé d'un autre appareil sur lui, `state.ctx` absent (pas illisible ni
     * dans le nuage) : aucun autre appareil n'a rien accepté de lui, la borne de la règle 1 est vide. Sans cette exception, `canPublish`
     * refuse pour toujours (instantané listé, état absent) : l'appareil ne publie jamais rien.
     */
    // Les fichiers d'une orpheline déjà abandonnée (suppression en attente) ne comptent pas : aucun état ne les annonce.
    const files = (ownScan?.epochs ?? []).filter((e) => e.epoch !== orphanLeft || e.epoch === currentEpoch).reduce((n, e) => n + e.segments.length + e.snapshots.length, 0);
    const openedHere =
      currentEpoch === localEpoch &&
      folderE === null &&
      unreadable.length === 0 &&
      isOrphanEpoch({
        epoch: localEpoch,
        ownStateOk: ownState !== null,
        ownStateStatus: ownScan?.stateStatus,
        acksOnSelf: acksOnSelf.length,
        localStateSeq: localSeq,
        storedSnapshot: storedSnapshot,
        ownEpochs: ownScan?.epochs ?? [],
      });
    const publishAllowed =
      canPublish({
        ownStateOk: ownState !== null,
        acksOnSelf: acksOnSelf.length,
        listedFiles: files,
        localStateSeq: localSeq,
      }) ||
      openedHere ||
      ownScan?.stateStatus === 'foreign' ||
      ownScan?.stateStatus === 'corrupt';
    if (openedHere && !canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: files, localStateSeq: localSeq })) logger.log('own-state-recovered', { epoch: currentEpoch });
    let head: DeviceAck = { epoch: currentEpoch, segment: bounds.head.segment, record: bounds.head.record, hlc: bounds.headHlc, stateSeq: 0 };
    let snapshotMeta = storedSnapshot?.epoch === currentEpoch ? { seq: storedSnapshot.seq, endHlc: storedSnapshot.endHlc } : null;
    const purgeHorizon = await readJson<Hlc>(repos, META.purgeHorizon);
    const ackMap = async (): Promise<Map<DeviceId, DeviceAck>> => {
      const rows = await repos.sync.getStates();
      const acks = new Map<DeviceId, DeviceAck>();
      for (const row of rows) {
        // Y-10 (ADR 0011 §18 point 11) : l'accusé sur un appareil oublié reste publié, figé à sa position (il n'est plus lu), même une
        // fois terminé : sans lui, un autre actif ne verrait jamais la coupure atteinte (finalisation bloquée, seconde revue point 5).
        // Y-11 (§18 point 14) : à travers une réinitialisation, il garde l'époque de sa position (`n`), jamais remis au début de `n+1`.
        if (row.isSelf || row.epoch === null) continue;
        const forgotten = forgetView.order.has(row.deviceId as DeviceId);
        // Pendant une réinitialisation, la position en `n` d'un appareil pas encore lu dans `n+1` reste publiée (figée à l'import).
        const frozen = resetActive(directive) && compareEpochs(row.epoch as EpochId, currentEpoch) < 0;
        if (row.epoch !== currentEpoch && !forgotten && !frozen) continue;
        acks.set(row.deviceId as DeviceId, { epoch: row.epoch as EpochId, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: row.stateSeq });
      }
      return acks;
    };
    /**
     * Y-TECH-01 (revue, point 2) : `covers` d'un instantané écrit par cet appareil = ses accusés publiés (`ackMap`, inchangé), plus la
     * position **héritée** de chaque ligne restée dans une époque antérieure (ce que sa base contient d'un appareil qui n'a rien publié
     * dans l'époque courante, §9.1 (d)). Sans elle, un appareil qui remplace ou reprend depuis cet instantané (autre que celui
     * d'ouverture) n'aurait aucune position sur cet appareil, et l'oubli de celui-ci attendrait sans fin (condition (f)).
     */
    const snapshotCovers = async (): Promise<Map<DeviceId, DeviceAck>> => {
      const covers = await ackMap();
      for (const row of await repos.sync.getStates()) {
        if (row.isSelf || row.epoch === null || covers.has(row.deviceId as DeviceId) || compareEpochs(row.epoch as EpochId, currentEpoch) >= 0) continue;
        covers.set(row.deviceId as DeviceId, { epoch: row.epoch as EpochId, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: row.stateSeq });
      }
      return covers;
    };
    const nextState = async (h: DeviceAck): Promise<PublishedDeviceState> => buildState(currentEpoch, h, stateSeq + 1, snapshotMeta, purgeHorizon, await ackMap());

    if (publishAllowed) {
      await resolveInflight(deps, async (h) => {
        const ok = await writeState(await nextState(h), true);
        if (ok) head = h;
        return ok;
      });
    }

    // 4. Lecture (avec reprise depuis l'instantané si demandée ou nécessaire, une fois par cycle).
    const knows = await knowsFrom(repos, logger);
    /** Repères de ses états publiés, lus au premier segment absent du cycle (quatrième revue, point D). */
    let ownMarks: readonly OwnStateMark[] | undefined;
    let resumed = false;
    /** Cinquième revue, point 6 : appareils tronqués dans ce cycle (leur `corrupt` de l'audit M3 n'est jamais levé par un trou effacé). */
    const truncatedThisCycle = new Set<DeviceId>();
    /**
     * Septième revue, point 1 (audit M3, ADR 0011 §5.5) : la reprise de ce cycle attend le corps du premier choix (instantané éligible le
     * plus récent, qui peut couvrir au-delà du point corrompu) : une troncature n'est pas `corrupt`, l'attente d'iCloud est visible.
     */
    let resumeWaiting = false;
    const doResume = async (): Promise<boolean> => {
      resumed = true;
      work();
      // Reprise mémorisée avant toute modification ; effacée par la dernière transaction de la reprise (avec les curseurs).
      await writeJson(repos, META.resume, true);
      // Y-06 : un nouvel appareil (aucune époque suivie avant ce cycle, ou arrivée commencée) rejoint par tranches, avec progression,
      // reprise au même endroit et échec mémorisé (src/sync/join.ts) ; les autres reprises sont inchangées.
      if (await isJoining(repos, localEpoch)) {
        const joined = await joinFromSnapshot(deps, currentEpoch, accepted, ownState, knows, hooks, pending, coverage());
        if (joined.tried) resumeTried = joined.tried;
        return joined.applied;
      }
      const outcome = await resumeFromSnapshot(deps, currentEpoch, accepted, ownState, knows, hooks, pending, coverage());
      if (outcome.kind === 'no-eligible') noEligible = outcome.uncovered;
      // Cinquième revue, point 1 : instantané essayé (écrit par la reprise) ; inchangé si le premier choix attend iCloud.
      if (outcome.tried) resumeTried = outcome.tried;
      resumeWaiting = outcome.kind === 'waiting';
      return outcome.kind === 'done';
    };
    /**
     * Quatrième revue, point B (ADR 0011 §5.5, « Trou impossible à combler ») : trous mémorisés (`sync_meta.segmentGaps`). Effacement
     * dans la même transaction que la ligne `sync_state` : lecture au-delà du trou, changement d'époque, appareil oublié ou retiré ;
     * `corrupt` posé par la règle remis à `active` (sauf oubli, dont le statut suit l'ordre total).
     */
    const persistGaps = (tx: Repositories): Promise<void> => writeJson(tx, META.segmentGaps, segmentGaps.size === 0 ? null : Object.fromEntries(segmentGaps));
    const clearGap = (id: DeviceId, activate: boolean): Promise<void> => clearSegmentGap(deps, segmentGaps, id, { activate, truncated: truncatedThisCycle });
    /** Instantané éligible le plus récent de l'époque (fins déjà lues, gardées par `readSnapshotEnd`). */
    const latestEligible = async (epochRead: EpochId): Promise<SnapshotRef | null> => {
      const cov = coverage();
      const candidates = await snapshotCandidates(deps, epochRead, [...accepted.values(), ...(ownState ? [ownState] : [])], cov);
      const pick = pickEligible(candidates, cov, epochRead, new Set());
      return pick.kind === 'ok' ? { author: pick.end.author, seq: pick.end.seq } : null;
    };
    {
      const rowsNow = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
      for (const [id, gap] of [...segmentGaps]) {
        // Cinquième revue, point 3 : changement d'époque, oubli, retrait (plus de ligne `sync_state`) ; une absence au scan ne l'efface pas.
        const forgotten = forgetView.order.has(id);
        // Cinquième revue, point 4 : une entrée sur soi (règle précédente) est effacée.
        if (id === self || gap.epoch !== currentEpoch || forgotten || !rowsNow.has(id)) await clearGap(id, !forgotten);
      }
    }
    /** Aucun instantané éligible trouvé par une reprise de ce cycle (§14.2) : oublié non couvert. */
    let noEligible: DeviceId | null = null;
    /** Trous sur les oubliés (§18 point 11) : curseur sous la coupure et journal disparu (terminé, ou `state.ctx` absent). */
    const gaps = async (): Promise<readonly DeviceId[]> => {
      if (forgetView.order.size === 0) return [];
      const cursors = new Map<DeviceId, DeviceAck>();
      for (const row of await repos.sync.getStates()) {
        // Y-11 (§18 point 14) : position sur l'oublié dans l'époque où elle a été lue (`n` à travers une réinitialisation).
        if (forgetView.order.has(row.deviceId as DeviceId) && row.epoch !== null) cursors.set(row.deviceId as DeviceId, { epoch: row.epoch as EpochId, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: 0 });
      }
      const gone = new Set<DeviceId>(forgetView.done);
      for (const id of forgetView.order.keys()) {
        const listing = scan.devices.find((d) => d.deviceId === id);
        // §18 point 14 : des fichiers chiffrés sous une clé qui n'est plus détenue (« Clé différente ») ne comblent plus rien.
        if (!listing || listing.stateStatus === 'missing' || (listing.stateStatus === 'foreign' && !resetActive(directive))) gone.add(id);
      }
      const cov = coverage();
      return forgetGaps(cov.master, cov.ackers, cursors, gone);
    };
    const gapsBefore = await gaps();
    if (gapsBefore.length > 0 && !resume) {
      logger.log('forget-gap', { device: gapsBefore[0] ?? null });
      resume = true;
    }
    // « Lancer une reprise complète » (§24) : décision explicite de l'utilisateur d'arrêter de protéger les traces de l'orpheline. Traces,
    // avertissement et acquittement sont effacés **avant** les lectures : l'opération rejouée passe par la fusion ordinaire (la donnée reçue
    // l'emporte comme d'habitude, rien de local n'est perdu) et une seule demande suffit. Une reprise automatique ne touche à rien : un coup
    // porté pendant elle lève l'avertissement.
    if (resume && (await repos.sync.getMeta(META.orphanTraceAck)) !== null) {
      await writeJson(repos, META.orphanTraces, null);
      await writeJson(repos, META.orphanTraceHit, null);
      await writeJson(repos, META.orphanTraceAck, null);
    }
    if (resume) await doResume();

    let allRead = true;
    /** Appareils lus jusqu'à leur tête dans ce cycle (leurs segments listés dans le nuage ont été téléchargés par la lecture). */
    const readToHead = new Set<DeviceId>();
    for (let pass = 0; pass < 2; pass += 1) {
      let needResume = false;
      const truncated: string[] = [];
      /** Trous de ce passage qui demandent une reprise (mémorisés si elle échoue). */
      const resumeHoles: { id: DeviceId; epoch: EpochId; segment: number }[] = [];
      allRead = true;
      const rows = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
      /**
       * Quatrième revue, point B ; cinquième revue, point 1 (ADR 0011 §5.5) : segment nécessaire tenu pour purgé sur `id` (jamais un
       * cycle complet). Instantané éligible le plus récent déjà essayé (`resumeTried`) : trou mémorisé, `corrupt`, aucune reprise ;
       * sinon reprise (une par cycle ; si elle échoue, la règle est réévaluée sur l'instantané qu'elle a essayé). Un oublié suit sa propre
       * règle (§18 point 11) : reprise.
       */
      const hole = async (id: DeviceId, epochRead: EpochId, segment: number): Promise<void> => {
        if (forgetView.order.has(id)) {
          needResume = true;
          return;
        }
        // Cinquième revue, point 4 : soi hors règle. Une reprise au plus par cycle ; ensuite la ligne est ignorée (l'étape 5 replace le
        // curseur sur soi à sa tête ; ses écritures sont dans sa base ou dans l'instantané qui a permis leur purge).
        if (id === self) {
          if (!resumed) needResume = true;
          else logger.log('self-segment-gap', { segment });
          return;
        }
        allRead = false;
        const decision = decideSegmentGap({ existing: segmentGaps.get(id), epoch: epochRead, segment, tried: resumeTried, latest: await latestEligible(epochRead), now: iso(deps.clock.nowMs()) });
        if (decision.kind === 'resume') {
          if (!resumed) {
            needResume = true;
            resumeHoles.push({ id, epoch: epochRead, segment });
          }
          return;
        }
        if (decision.changed) {
          segmentGaps.set(id, decision.gap);
          logger.log('segment-gap', { device: id, segment, author: decision.gap.author, seq: decision.gap.seq });
        }
        await data.transaction(async (tx) => {
          if (decision.changed) await persistGaps(tx);
          await tx.sync.saveState(id, { status: 'corrupt' });
        });
      };
      const targets: { id: DeviceId; head: DeviceAck; epochListing: DeviceScan['epochs'][number] | undefined; limit?: DeviceAck; epoch?: EpochId }[] = [];
      // §18 point 14 (rattrapage) : tant que cet appareil détient l'ancienne clé (appareil qui réinitialise, réassocié avant sa bascule),
      // chaque oublié retenu est lu dans l'époque de l'annonce `n`, jusqu'à sa coupure et jamais au-delà.
      const catchUpEpoch = (directive.kind === 'initiator' || directive.kind === 'joined') && directive.view.epoch === currentEpoch ? (directive.view.noticeEpoch ?? null) : null;
      for (const [id, state] of accepted) {
        // Y-10 (§18 point 12) : les fichiers d'un terminé ne sont jamais relus, même s'il en réapparaît ou si son oubli est annulé.
        if (forgetView.done.has(id)) continue;
        const row = rows.get(id);
        if (forgetView.order.has(id)) {
          // Y-10 : appareil oublié, lu jusqu'à la coupure (maximum des accusés des appareils actifs et de sa position locale), jamais au-delà.
          const readEpoch = catchUpEpoch !== null && state.epoch === catchUpEpoch ? catchUpEpoch : currentEpoch;
          const local: DeviceAck | null = row?.epoch === readEpoch ? { epoch: readEpoch, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: 0 } : null;
          const limit = readLimit(id, forgetView, accepted, lastWritten ?? ownState, local);
          if (state.epoch !== readEpoch || limit === null || limit.epoch !== readEpoch) continue;
          const head = compareCursors(state.head, limit) <= 0 ? state.head : { ...state.head, segment: limit.segment, record: limit.record };
          const epochListing = scan.devices.find((d) => d.deviceId === id)?.epochs.find((e) => e.epoch === readEpoch);
          targets.push({ id, head, epochListing, limit, epoch: readEpoch });
          continue;
        }
        const epochListing = scan.devices.find((d) => d.deviceId === id)?.epochs.find((e) => e.epoch === currentEpoch);
        // Quatrième revue, point B : un appareil `corrupt` par un trou mémorisé reste une cible (règle du trou réévaluée à chaque cycle).
        if (state.epoch !== currentEpoch || row?.status === 'foreign' || row?.status === 'newer-major' || row?.status === 'rollback' || (row?.status === 'corrupt' && !segmentGaps.has(id))) {
          if (state.epoch === currentEpoch && row?.status !== 'expired') allRead = false;
          continue;
        }
        targets.push({ id, head: state.head, epochListing });
      }
      // Soi-même : seulement après une reprise (ses écritures au-delà de l'instantané, base restaurée).
      const selfState = rows.get(self);
      if (selfState?.epoch === currentEpoch && compareCursors({ segment: selfState.cursorSegment, record: selfState.cursorRecord }, head) < 0 && ownState?.epoch === currentEpoch) {
        targets.push({ id: self, head: ownState.head, epochListing: listed });
      }
      for (const target of targets) {
        const row = rows.get(target.id);
        const readEpoch = target.epoch ?? currentEpoch;
        const cursor: RecordCursor = row?.epoch === readEpoch ? { segment: row.cursorSegment, record: row.cursorRecord } : ZERO;
        if (row?.epoch !== readEpoch) await repos.sync.saveState(target.id, { epoch: readEpoch, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
        if (compareCursors(cursor, target.head) >= 0) {
          readToHead.add(target.id);
          await clearGap(target.id, !forgetView.order.has(target.id));
          continue;
        }
        // Segment nécessaire disparu (purgé) : reprise depuis l'instantané.
        const minListed = Math.min(...(target.epochListing?.segments ?? [Infinity]));
        if (cursor.segment > 0 && Number.isFinite(minListed) && cursor.segment < minListed) {
          // Y-TECH-02 (QA) : une purge seulement si l'état publié la rend possible ; sinon le fichier n'est pas encore arrivé (désordre
          // d'iCloud) : attente visible, jamais une reprise à chaque cycle.
          const writer = accepted.get(target.id) ?? (target.id === self ? ownState : null);
          const ownPublished = lastWritten ?? ownState;
          // Troisième revue, point 2 (ADR 0011 §5.5) : preuve tirée de l'état accepté de l'écrivain (il nous compte parmi ses lecteurs
          // actifs), jamais de notre propre activité.
          const own = { self: deps.deviceId, segment: cursor.segment, epoch: readEpoch, ownAck: ownPublished?.acks.get(target.id) ?? null, marks: (ownMarks ??= await readOwnStateMarks(repos, logger)) };
          if (writer && purgeExplainsMissingSegment(writer, row?.ackHlc ?? null, deps.clock.nowMs(), own)) {
            await hole(target.id, readEpoch, cursor.segment);
          } else {
            allRead = false;
            pending.add(`${String(target.id).slice(0, 8)}/${readEpoch}/${segmentFileName(cursor.segment)}`);
            logger.log('segment-awaited', { device: target.id, segment: cursor.segment });
          }
          continue;
        }
        if (cursor.segment === 0 && Number.isFinite(minListed) && minListed > 1) {
          await hole(target.id, readEpoch, 0);
          continue;
        }
        if (segmentGaps.has(target.id)) {
          // Cinquième revue, point 3 : trou effacé seulement quand la lecture peut reprendre (listage fini, aucune condition de trou) ; listage de
          // l'époque absent : rien n'est effacé ni lu, fichier en attente visible.
          if (!Number.isFinite(minListed)) {
            allRead = false;
            pending.add(`${String(target.id).slice(0, 8)}/${readEpoch}`);
            continue;
          }
          // Sixième revue, point 4 : listage fini et aucune condition de trou (les branches de trou ci-dessus sont passées, y compris
          // `cursor.segment === 0` avec `minListed <= 1`) : effacé AVANT la lecture, pour qu'une troncature lue ensuite pose un `corrupt`
          // de l'audit M3 qu'aucun effacement ultérieur ne lève.
          await clearGap(target.id, !forgetView.order.has(target.id));
        }
        work();
        const outcome = await readDevice(deps, {
          deviceId: target.id,
          epoch: readEpoch,
          cursor,
          ackHlc: row?.epoch === readEpoch ? row.ackHlc : null,
          knows,
          onBatch: hooks.onRemoteChanges,
          ...(target.limit ? { limit: target.limit } : {}),
        });
        if (outcome.status !== 'complete') allRead = false;
        else readToHead.add(target.id);
        if (outcome.status === 'cloud-pending') pending.add(`${String(target.id).slice(0, 8)}/${readEpoch}`);
        if (outcome.status === 'truncated') {
          truncatedThisCycle.add(target.id);
          if (resumed && !resumeWaiting) await repos.sync.saveState(target.id, { status: 'corrupt' });
          else {
            needResume = true;
            truncated.push(target.id);
          }
        }
        if (target.id !== self && !forgetView.order.has(target.id)) {
          const status = outcome.status === 'truncated' ? (resumed && !resumeWaiting ? 'corrupt' : undefined) : outcome.status === 'clock-ahead' ? 'clock-ahead' : outcome.status === 'newer-major' ? 'newer-major' : outcome.status === 'foreign' ? 'foreign' : row?.status === 'clock-ahead' ? 'active' : undefined;
          if (status) await repos.sync.saveState(target.id, { status });
        }
      }
      if (!needResume || resumed) break;
      if (!(await doResume())) {
        // Aucun instantané lisible : les appareils corrompus le restent, les autres sont lus normalement.
        if (!resumeWaiting) for (const id of truncated) await repos.sync.saveState(id, { status: 'corrupt' });
        // Quatrième revue, point B : trous que cette reprise devait combler, mémorisés sans instantané appliqué (jamais une reprise
        // à chaque cycle avec le même instantané éligible).
        for (const h of resumeHoles) await hole(h.id, h.epoch, h.segment);
        break;
      }
    }

    // Revue Y-IOS (QA) : seuls les fichiers dont ce lecteur a encore besoin le tiennent « en attente d'iCloud ». Un instantané listé dans le
    // nuage n'est lu que par une reprise, qui l'ajoute elle-même s'il lui manque ; un segment sous le curseur, ou celui du curseur d'un
    // appareil lu jusqu'à sa tête, est déjà lu. Sans épinglage (iPhone), iCloud ne télécharge jamais ces fichiers d'office : les compter
    // tiendrait l'appareil « en attente » pour toujours.
    {
      const rowsNow = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
      for (const entry of scanPending) {
        if (/^(?:.+\/)?s-\d{8}\.cts$/.test(entry.file)) {
          pending.delete(entry.key);
          continue;
        }
        const segment = /^(.+)\/j-(\d{8})\.ctj$/.exec(entry.file);
        const row = rowsNow.get(entry.deviceId);
        if (!segment || !row || row.epoch !== segment[1]) continue;
        const n = Number(segment[2]);
        if (n < row.cursorSegment || (n === row.cursorSegment && readToHead.has(entry.deviceId))) pending.delete(entry.key);
      }
    }

    // Opérations mises de côté (parent ou ligne arrivés depuis) : retentées après la lecture.
    if ((await repos.sync.parkedCount(['missing-parent', 'missing-row'])) > 0) {
      const retried = await retryParked(deps);
      if (retried.size > 0) hooks.onRemoteChanges(retried);
      // Y-IOS-02 (point de contrôle 0.2.3, étape 4) : tout est lu jusqu'aux têtes et des opérations attendent encore une ligne qui manque :
      // un enregistrement a été sauté (curseur posé trop loin). Une reprise depuis l'instantané (fusion, rien n'est effacé) replace les
      // curseurs aux positions couvertes et relit les journaux ; une seule demande par époque, ensuite l'avertissement reste visible.
      if (allRead && (await repos.sync.parkedCount(['missing-row'])) > 0) {
        seen.warnings = [...(seen.warnings ?? []), 'received-unapplied'];
        const tried = await readJson<{ epoch: EpochId }>(repos, META.parkedResume);
        if (tried?.epoch !== currentEpoch && !resumed) {
          await data.transaction(async (tx) => {
            await writeJson(tx, META.parkedResume, { epoch: currentEpoch });
            await writeJson(tx, META.resume, true);
          });
          logger.log('parked-resume-requested', { epoch: currentEpoch });
        }
      }
    }

    // Y-IOS-02 (§24 point 4 (a)) : une opération reçue a visé une trace purgée dans l'orpheline abandonnée : divergence visible.
    // Persiste tant que l'utilisateur ne l'a pas acquitté (« Lancer une reprise complète » : `orphanTraceAck`, effacé avec la trace au cycle qui reprend).
    // La garde ne sert que jusqu'à la fin de la reprise qui suit l'abandon : ensuite les traces mémorisées sont vidées.
    if (resumed && allRead && (await repos.sync.getMeta(META.orphanTraces)) !== null) await writeJson(repos, META.orphanTraces, null);
    if ((await repos.sync.getMeta(META.orphanTraceHit)) !== null) seen.warnings = [...(seen.warnings ?? []), 'received-unapplied'];

    // 5. Publication.
    let publishError: string | null = null;
    if (publishAllowed) {
      const before = await repos.sync.outboxCount();
      if (before > 0) {
        const result = await publishOutbox(deps, currentEpoch, head, bounds.maxSegment);
        if (result.published > 0) work();
        head = result.head;
        publishError = result.error;
      }
      await repos.sync.saveState(self, { epoch: currentEpoch, cursorSegment: head.segment, cursorRecord: head.record, ackHlc: head.hlc, headSegment: head.segment, headRecord: head.record, headHlc: head.hlc });
    } else {
      logger.log('publish-deferred', { reason: 'own-state-unknown' });
      // Exigence d'Ali : jamais « À jour » ni silence quand cet appareil ne peut pas publier (avertissement visible dans Détails et en bandeau).
      seen.warnings = [...(seen.warnings ?? []), 'publish-blocked'];
    }

    // 6. État publié (réécrit s'il a changé, ou s'il a été remplacé par un tiers). Y-11 : l'annonce de l'appareil qui réinitialise est
    // toujours publiée (forcée) tant que l'époque visée n'est pas ouverte.
    const announcing = noticeToPublish(directive, currentEpoch) !== null;
    const forceState = ownScan?.stateStatus === 'foreign' || ownScan?.stateStatus === 'corrupt' || ownState?.epoch !== currentEpoch || announcing;
    if (publishAllowed) await writeState(await nextState(head), forceState);
    if (announcing && directive.kind === 'initiator') {
      // §14.3 étapes 3 et 4 : annonce publiée sous l'ancienne clé, puis époque visée ouverte sous la nouvelle (instantané, état).
      const announced = (lastWritten as PublishedDeviceState | null)?.reset ?? null;
      if (announced === null) {
        await recordResetFailure(deps, 'announced', publishAllowed ? 'state-mismatch' : 'cloud-pending');
        return { ...EMPTY, outcome: 'done', folderLabel, folderKind, worked, pendingFiles: [...pending], devices: await deviceStatuses(repos, self, accepted, deps.sv, logger), keyMismatch };
      }
      const covers = await snapshotCovers();
      // Cinquième revue, point 6 (§5.1) : entrée de l'auteur seulement si sa tête désigne une écriture.
      if (head.hlc !== null) covers.set(self, { ...head, stateSeq });
      const listedNext = ownScan?.epochs.find((e) => e.epoch === directive.view.epoch)?.snapshots ?? [];
      // §18 point 14 : l'état sous la nouvelle clé porte les accusés sur les oubliés retenus, à leur position de l'époque `n` (coupure).
      const forgottenAcks = new Map([...covers].filter(([id]) => forgetView.order.has(id)));
      await openResetEpoch(deps, {
        target: directive.view.epoch,
        covers,
        listedSnapshots: listedNext,
        writeState: (state) => writeState(state, true),
        buildState: (target, h, snapshot) => buildState(target, h, stateSeq + 1, snapshot, purgeHorizon, forgottenAcks),
      });
      logger.log('reset-announced', { epoch: directive.view.epoch });
      return { ...EMPTY, outcome: 'done', folderLabel, folderKind, worked: true, pendingFiles: [...pending], devices: await deviceStatuses(repos, self, accepted, deps.sv, logger), keyMismatch };
    }
    // Trous restants après la lecture (aucun instantané éligible) : attente visible, aucun instantané écrit (§18 point 11).
    const gapsAfter = await gaps();
    await setSnapshotWait(deps, gapsAfter[0] ?? noEligible);

    // 7. Entretien : instantané si dû, purges, plafonds.
    if (publishAllowed && allRead && publishError === null) {
      // Y-10 (§18 point 11) : avec des oubliés retenus, seuls les instantanés éligibles comptent (7 jours, purge) ; un instantané n'est
      // écrit que s'il couvre chaque oublié retenu et sans trou ; hors règle des 7 jours quand aucun éligible n'existe ou que la
      // condition (h) l'attend avant une suppression.
      const due = await snapshotDue(deps, { epoch: currentEpoch, view: forgetView, coverage: coverage(), ackMap, snapshotMeta, states, gapsAfter, known: () => forgetKnownDevices(scan, forgetView, accepted, self, lastWritten ?? ownState), own: lastWritten ?? ownState });
      if (due) {
        work();
        const listedSnapshots = listed?.snapshots ?? [];
        const seq = Math.max(snapshotMeta?.seq ?? 0, ...listedSnapshots) + 1;
        const covers = await snapshotCovers();
        // Entrée de l'auteur (ADR 0011 §5.1, quatrième revue, point A) : sa tête publiée, si elle désigne une écriture (hlc non nul) ;
        // sans elle, un lecteur qui reprend depuis cet instantané repartirait du début de l'époque sur cet appareil.
        if (head.hlc !== null) covers.set(self, { ...head, stateSeq });
        const endHlc = deps.hlc.now();
        deps.deadline?.check('snapshot');
        await platform.writeSnapshot({ epoch: currentEpoch, seq, sv: deps.sv, records: snapshotPages(repos, currentEpoch, covers, deps.sv) });
        snapshotMeta = { seq, endHlc };
        await writeJson(repos, META.snapshot, { epoch: currentEpoch, ...snapshotMeta, coveredSegment: head.segment, covers: Object.fromEntries(covers) });
        await writeState(await nextState(head), true);
        const old = [...listedSnapshots, seq].sort((a, b) => b - a).slice(SNAPSHOTS_KEPT_PER_EPOCH);
        // Échec journalisé (aucun échec silencieux) ; retentée au prochain instantané, les fichiers restants ne gênent aucune lecture.
        if (old.length > 0) deps.deadline?.check('delete-own');
        if (old.length > 0) await platform.deleteOwn(old.map((n) => ({ epoch: currentEpoch, kind: 's' as const, n }))).catch((error: unknown) => logger.log('delete-own-failed', { kind: 's', code: syncErrorCodeOf(error) }));
        logger.log('snapshot-written', { epoch: currentEpoch, seq });
      }
      // Y-11 : anciennes époques gardées pendant une réinitialisation (supprimées par la bascule, ou relues si elle perd).
      await maintain(deps, { epoch: currentEpoch, head, accepted: live, ownScan, rows: await repos.sync.getStates(), coverage: coverage(), revived: forgetView.revived.filter((r) => r.done).map((r) => r.deviceId), keepOldEpochs: resetActive(directive) });
    }

    // Y-IOS-02 (ADR 0011 §24 point 4 (e)) : fichiers de l'orpheline abandonnée, supprimés au mieux (`sync_delete_own` : l'époque n'est plus
    // courante). Échec : journal avec son code (comme les autres suppressions de l'étape 7), retenté à chaque cycle ; ni la lecture ni la
    // publication n'attendent.
    {
      const left = await readJson<{ epoch: EpochId }>(repos, META.orphanEpoch);
      if (left !== null && left.epoch !== currentEpoch && (await readJson<EpochId>(repos, META.epoch)) !== left.epoch) {
        if (ownScan?.epochs.some((e) => e.epoch === left.epoch)) {
          deps.deadline?.check('delete-own');
          try {
            await platform.deleteOwn([{ epoch: left.epoch, kind: 'epoch' }]);
            await writeJson(repos, META.orphanEpoch, null);
            logger.log('orphan-epoch-deleted', { epoch: left.epoch });
          } catch (error) {
            if (isCycleInterrupted(error)) throw error;
            logger.log('orphan-epoch-delete-failed', { code: syncErrorCodeOf(error) });
          }
        } else {
          await writeJson(repos, META.orphanEpoch, null);
          logger.log('orphan-epoch-cleared', { epoch: left.epoch });
        }
      }
    }

    // Y-10 : suppression des fichiers des appareils oubliés (conditions de Rust vérifiées d'abord, aucune boîte) ; jamais pendant une
    // réinitialisation (Rust la refuse, condition (b)).
    if (publishAllowed && forgetView.order.size > 0 && !resetActive(directive)) {
      const ownPublished = lastWritten ?? ownState;
      const ownSnapshot: SnapshotEndRead = ownPublished && ownPublished.epoch === currentEpoch ? snapshotInEpoch(await readSnapshotEnd(deps, ownPublished), currentEpoch) : 'none';
      await runForgetDeletions(deps, { view: forgetView, scan, accepted, ownPublished, ownSnapshot });
    }

    // 8. Heure de dernière synchro (jamais après l'échéance d'un cycle borné : le cycle n'est pas complet).
    deps.deadline?.check('finish');
    const lastSyncAt = iso(deps.clock.nowMs());
    if (publishError === null && pending.size === 0) await repos.sync.saveState(self, { lastSyncAt });
    // Y-11 (revue 13) : un appareil attendu par la réinitialisation est toujours dans APPAREILS (« jamais vu » s'il n'a jamais été lu).
    const resetWaiting = directive.kind === 'initiator' ? directive.view.waiting : [];
    const devices = withUnseenDevices(await deviceStatuses(repos, self, accepted, deps.sv, logger), scan, self, [...(await readWaitingDevices(repos)), ...resetWaiting]);
    // Y-11 : précondition calculée sur ce qui vient d'être lu et publié (mêmes règles que Rust).
    const resetLag = options.resetCheck ? resetLagging(deps, { scan, forget: forgetView, accepted, own: lastWritten ?? ownState }) : undefined;
    const lag = resetLag === undefined ? {} : { resetLag };
    if (publishError !== null) return { ...EMPTY, outcome: 'failed', errorCode: publishError as SyncErrorCode, pendingFiles: [...pending], devices, folderLabel, folderKind, worked, keyMismatch, ...lag };
    return { outcome: 'done', errorCode: null, pendingFiles: [...pending], devices, keyMismatch, folderLabel, folderKind, lastSyncAt: pending.size === 0 ? lastSyncAt : (selfRow?.lastSyncAt ?? null), worked, ...lag };
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    const code = syncErrorCodeOf(error);
    logger.log('cycle-error', { code });
    // Y-11 : un échec pendant une réinitialisation est gardé avec son étape (jamais seulement journalisé).
    if (directive.kind === 'initiator' || directive.kind === 'joined') {
      const step = directive.kind === 'joined' ? 'joined' : directive.view.stage === 'opened' ? 'waiting-devices' : 'snapshot';
      try {
        await recordResetFailure(deps, step, code);
      } catch {
        logger.log('reset-failure-unrecorded', { code });
      }
    }
    return failWith(error, { folderLabel, folderKind, pendingFiles: [...pending] });
  }
}

/**
 * Quatrième revue, point D : repères de ses états publiés (`sync_meta.ownStateHlcs`). Valeur illisible : journalisée (`state-unreadable`,
 * sans contenu) et lue comme aucun repère : aucune preuve (règle des 30 jours), liste réécrite à la prochaine écriture de son état.
 */
async function readOwnStateMarks(repos: Repositories, log: StoredStateLog): Promise<OwnStateMark[]> {
  try {
    return parseStoredOwnStateMarks(await repos.sync.getMeta(META.ownStateHlcs), `sync_meta.${META.ownStateHlcs}`, log);
  } catch (error) {
    if (isSyncStateUnreadable(error)) return [];
    throw error;
  }
}

/**
 * Effacement d'un trou mémorisé (ADR 0011 §5.5) : retiré de `gaps` et de `sync_meta.segmentGaps`, dans la même transaction que la ligne
 * `sync_state` ; `corrupt` remis à `active` seulement si le trou était mémorisé (le `corrupt` vient de lui) et si l'appareil n'a pas été
 * tronqué dans ce cycle (`truncated`, `corrupt` de l'audit M3 gardé). Cinquième revue, point 6 ; sixième revue, point 3 : garde de
 * défense, inatteignable aujourd'hui (l'effacement précède toujours la lecture), gardée contre un réordonnancement futur.
 */
export async function clearSegmentGap(
  deps: Pick<SyncDeps, 'data' | 'logger'>,
  gaps: Map<DeviceId, StoredSegmentGap>,
  id: DeviceId,
  input: { readonly activate: boolean; readonly truncated: ReadonlySet<DeviceId> },
): Promise<void> {
  if (!gaps.has(id)) return;
  gaps.delete(id);
  await deps.data.transaction(async (tx) => {
    await writeJson(tx, META.segmentGaps, gaps.size === 0 ? null : Object.fromEntries(gaps));
    const current = (await tx.sync.getStates()).find((r) => r.deviceId === id);
    if (input.activate && current?.status === 'corrupt' && !input.truncated.has(id)) await tx.sync.saveState(id, { status: 'active' });
  });
  deps.logger.log('segment-gap-cleared', { device: id });
}

/** Constats du cycle hors étapes : avertissements du scan, valeur locale illisible relue vide (cinquième revue, points 2 et 5). */
interface CycleSeen {
  warnings?: SyncWarningCode[];
  unreadable?: boolean;
}

/**
 * Cinquième revue, point 2 (ADR 0011 §5.5) : trous mémorisés. Illisible : journalisé (`state-unreadable`), `stateUnreadable` pour ce cycle,
 * lu comme « aucun trou », réécrit vide et chaque ligne `corrupt` remise à `active` (un `corrupt` de l'audit M3 est retrouvé à la
 * lecture suivante) ; jamais un `state-unreadable` à chaque cycle.
 */
async function readSegmentGaps(deps: SyncDeps, seen: CycleSeen): Promise<Map<DeviceId, StoredSegmentGap>> {
  try {
    return parseStoredSegmentGaps(await deps.data.repos.sync.getMeta(META.segmentGaps), `sync_meta.${META.segmentGaps}`, deps.logger);
  } catch (error) {
    if (!isSyncStateUnreadable(error)) throw error;
    seen.unreadable = true;
    await deps.data.transaction(async (tx) => {
      await writeJson(tx, META.segmentGaps, null);
      for (const row of await tx.sync.getStates()) if (row.status === 'corrupt') await tx.sync.saveState(row.deviceId, { status: 'active' });
    });
    return new Map<DeviceId, StoredSegmentGap>();
  }
}

/**
 * Cinquième revue, point 5 (ADR 0011 §5.5, condition 3) : repères illisibles : journalisés, `stateUnreadable` pour ce cycle, réécrits vides
 * dans ce cycle (aucune preuve, règle des 30 jours) ; le cycle suivant est propre.
 */
async function checkOwnStateMarks(deps: SyncDeps, seen: CycleSeen): Promise<void> {
  try {
    parseStoredOwnStateMarks(await deps.data.repos.sync.getMeta(META.ownStateHlcs), `sync_meta.${META.ownStateHlcs}`, deps.logger);
  } catch (error) {
    if (!isSyncStateUnreadable(error)) throw error;
    seen.unreadable = true;
    await writeJson(deps.data.repos, META.ownStateHlcs, []);
  }
}

/** Cinquième revue, point 2 : instantané essayé ; illisible : même règle que les trous (lu comme absent, réécrit vide). */
async function readResumeTried(deps: SyncDeps, seen: CycleSeen): Promise<ResumeTried | null> {
  try {
    return parseStoredResumeTried(await deps.data.repos.sync.getMeta(META.resumeTried), `sync_meta.${META.resumeTried}`, deps.logger);
  } catch (error) {
    if (!isSyncStateUnreadable(error)) throw error;
    seen.unreadable = true;
    await writeJson(deps.data.repos, META.resumeTried, null);
    return null;
  }
}

/** Accusés publiés par chaque appareil : le suppresseur avait-il lu l'écriture `hlc` de `device` ? */
async function knowsFrom(repos: Repositories, log: StoredStateLog): Promise<ApplyContext['knows']> {
  const acks = new Map<string, Map<DeviceId, DeviceAck>>();
  for (const row of await repos.sync.getStates()) acks.set(row.deviceId, parseStoredAcks(row.lastAcks, 'sync_state.last_acks', log));
  return (deleter, device, hlc) => {
    const ack = acks.get(deleter)?.get(device);
    return ack !== undefined && ack.hlc !== null && ack.hlc >= hlc;
  };
}

/**
 * Y-10 (audit a, §18 point 8) : tout appareil du dossier jamais lu (dossier sans état authentifié accepté) et tout appareil qui bloque une
 * suppression sont montrés dans APPAREILS, « jamais vu » (`seen: false`), pour pouvoir les oublier ; jamais une plateforme inventée.
 */
function withUnseenDevices(devices: SyncDeviceStatus[], scan: FolderScan, self: DeviceId, waiting: readonly DeviceId[]): SyncDeviceStatus[] {
  const listed = new Set(devices.map((d) => d.deviceId));
  const extra = [...scan.devices.map((d) => d.deviceId), ...waiting].filter((id) => id !== self && !listed.has(id));
  const unseen = [...new Set(extra)].sort().map((deviceId): SyncDeviceStatus => ({ deviceId, platform: 'windows', self: false, lastReadAt: null, status: 'active', seen: false }));
  return [...devices, ...unseen];
}

async function readWaitingDevices(repos: Repositories): Promise<DeviceId[]> {
  const status = await readForgetStatus(repos);
  return (status?.deletions ?? []).flatMap((d) => (d.waitingFor ? [d.waitingFor] : []));
}

/** Appareils affichés (APPAREILS) et leur version (Y-07 critère 11) : règle partagée avec les bandeaux A-09 (`deviceStatus.ts`). */
async function deviceStatuses(repos: Repositories, self: DeviceId, accepted: ReadonlyMap<DeviceId, PublishedDeviceState>, localSv: number, log: StoredStateLog): Promise<SyncDeviceStatus[]> {
  // Cinquième revue, point 7 : trous mémorisés (texte distinct). Une valeur illisible est signalée et réécrite au début du cycle
  // (`readSegmentGaps`) ; devenue illisible depuis, elle est journalisée ici et signalée au cycle suivant.
  let gaps: ReadonlyMap<DeviceId, StoredSegmentGap> = new Map<DeviceId, StoredSegmentGap>();
  try {
    gaps = parseStoredSegmentGaps(await repos.sync.getMeta(META.segmentGaps), `sync_meta.${META.segmentGaps}`, log);
  } catch (error) {
    if (!isSyncStateUnreadable(error)) throw error;
  }
  return storedDeviceStatuses(await repos.sync.getStates(), { self, accepted: new Set(accepted.keys()), localSv, gaps });
}

/**
 * Reprise depuis l'instantané en **fusion** (section 5.5) : file gardée, dernier instantané de l'époque appliqué par la fusion ordinaire
 * (identifiants purgés compris), puis lecture normale depuis `covers`. Les curseurs ne sont posés aux positions `covers` que dans la
 * **dernière** transaction de l'application (après les lignes et les traces), avec l'effacement de `sync_meta.resume` : un arrêt avant
 * laisse les curseurs et la demande de reprise intacts, et la reprise est rejouée (fusion idempotente).
 */
export async function resumeFromSnapshot(
  deps: SyncDeps,
  epoch: EpochId,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  ownState: PublishedDeviceState | null,
  knows: ApplyContext['knows'],
  hooks: CycleHooks,
  pending: Set<string>,
  coverage: ForgetCoverage,
): Promise<ResumeOutcome> {
  // (paramètre `accepted` : curseurs posés aussi pour chaque oublié retenu présent dans covers, `cursorIds`)
  // Y-10 (§18 point 11, seconde revue point 1) : instantané éligible seulement (auteur non oublié, annoncé, couvrant chaque oublié retenu).
  const candidates = await snapshotCandidates(deps, epoch, [...accepted.values(), ...(ownState ? [ownState] : [])], coverage);
  for (const c of candidates) if (c.end === 'cloud-pending') pending.add(`${String(c.state.deviceId).slice(0, 8)}/${epoch}/snapshot`);
  const excluded = new Set<DeviceId>();
  // Cinquième revue, point 1 (§5.5) : instantané essayé = premier choix (le plus récent éligible), appliqué ou écarté définitivement.
  const tried = triedTracker(candidates, coverage, epoch);
  for (;;) {
    const pick = pickEligible(candidates, coverage, epoch, excluded);
    if (pick.kind !== 'ok') {
      deps.logger.log('resume-unavailable', { epoch });
      // Sixième revue, point 1 : échec définitif (essai connu) : demande de reprise effacée avec l'instantané essayé.
      await tried.failDefinitively(deps.data);
      const value = tried.value();
      return pick.kind === 'none' && pick.uncovered !== null ? { kind: 'no-eligible', uncovered: pick.uncovered, tried: value } : { kind: 'unavailable', tried: value };
    }
    const { author: deviceId, seq } = pick.end;
    excluded.add(deviceId);
    const loaded = await loadSnapshot(deps, deviceId, epoch, seq);
    if (loaded === 'cloud-pending') {
      pending.add(`${String(deviceId).slice(0, 8)}/${epoch}/snapshot`);
      // Sixième revue, point 2 (§5.5) : premier choix au corps en attente d'iCloud : aucun repli sur un instantané inférieur ; fichier en
      // attente visible, demande de reprise gardée, réessayé seul au cycle suivant jusqu'à son arrivée.
      if (tried.isFirst(pick.end)) {
        deps.logger.log('resume-unavailable', { epoch });
        return { kind: 'waiting', tried: undefined };
      }
      continue;
    }
    if (!loaded) {
      tried.discarded(pick.end);
      continue;
    }
    tried.applying(pick.end);
    const now = iso(deps.clock.nowMs());
    // Dernière transaction (même fonction que l'arrivée, join.ts) : curseurs aux positions couvertes, fin de la reprise, instantané essayé.
    const result = await mergeSnapshot(deps, loaded, { localSv: deps.sv, remoteSv: loaded.end.sv, now, knows, logger: deps.logger }, hooks.onProgress, (tx) =>
      finishResumeTx(tx, deps, { epoch, from: deviceId, loaded, accepted, coverage, tried: tried.value() }),
    );
    if (result === 'clock-ahead') {
      // Instantané trop en avance (section 4.4) : écarté ; l'appareil qui l'a écrit est signalé.
      if (deviceId !== deps.deviceId) await deps.data.repos.sync.saveState(deviceId, { status: 'clock-ahead' });
      tried.discarded(pick.end);
      continue;
    }
    if (result.touched.size > 0) hooks.onRemoteChanges(result.touched);
    deps.logger.log('resumed-from-snapshot', { epoch, from: deviceId });
    return { kind: 'done', tried: tried.value() };
  }
}

/**
 * Résultat d'une reprise : `no-eligible` (§14.2) quand un candidat ne couvre pas un oublié retenu ; attente visible. `tried` : instantané
 * essayé désormais mémorisé (`sync_meta.resumeTried`), undefined s'il est inchangé (premier choix au corps en attente d'iCloud).
 */
export type ResumeOutcome =
  | { readonly kind: 'done'; readonly tried: ResumeTried | undefined }
  /** Septième revue, point 1 : corps du premier choix en attente d'iCloud (aucun repli ; demande gardée, fichier en attente visible). */
  | { readonly kind: 'waiting'; readonly tried: undefined }
  | { readonly kind: 'unavailable'; readonly tried: ResumeTried | undefined }
  | { readonly kind: 'no-eligible'; readonly uncovered: DeviceId; readonly tried: ResumeTried | undefined };

/** Plus de 64 accusés à publier : échec « oubli en échec » (étape `overflow`), effacé quand le scan n'en signale plus. */
async function recordForgetOverflow(deps: SyncDeps): Promise<void> {
  const failure = await readJson<{ step?: string }>(deps.data.repos, FORGET_META.failure);
  if (failure?.step === 'overflow') return;
  await writeJson(deps.data.repos, FORGET_META.failure, { deviceId: deps.deviceId, code: 'too-large', at: iso(deps.clock.nowMs()), step: 'overflow' });
}

/**
 * Instantané à écrire à l'étape 7 ? Sans oublié retenu : règle des 7 jours d'avant Y-10 (annonces des actifs et le sien). Avec des
 * oubliés retenus (§18 point 11) : jamais tant qu'il reste un trou, ni si ses curseurs ne couvrent pas chaque oublié retenu ; sinon dû
 * si aucun instantané éligible n'a moins de 7 jours, si aucun n'existe, ou si la condition (h) d'une suppression l'attend.
 */
async function snapshotDue(
  deps: SyncDeps,
  input: {
    readonly epoch: EpochId;
    readonly view: ForgetView;
    readonly coverage: ForgetCoverage;
    readonly ackMap: () => Promise<Map<DeviceId, DeviceAck>>;
    readonly snapshotMeta: { readonly seq: number; readonly endHlc: Hlc } | null;
    readonly states: readonly PublishedDeviceState[];
    readonly gapsAfter: readonly DeviceId[];
    readonly known: () => ReturnType<typeof forgetKnownDevices>;
    readonly own: PublishedDeviceState | null;
  },
): Promise<boolean> {
  const now = deps.clock.nowMs();
  if (input.view.order.size === 0) {
    const last = Math.max(input.snapshotMeta ? hlcMs(input.snapshotMeta.endHlc) : 0, ...input.states.filter((s) => s.epoch === input.epoch && s.snapshot).map((s) => hlcMs((s.snapshot as { endHlc: Hlc }).endHlc)));
    return now - last >= SNAPSHOT_INTERVAL_MS;
  }
  if (input.gapsAfter.length > 0) return false;
  const { master, ackers } = input.coverage;
  if (coversForgotten(await input.ackMap(), master, ackers) !== null) return false;
  const candidates = await snapshotCandidates(deps, input.epoch, [...input.states, ...(input.own ? [input.own] : [])], input.coverage);
  const pick = eligibleSnapshot(candidates, master, ackers, input.epoch);
  if (pick.kind === 'none') return true;
  if (pick.kind === 'ok' && now - hlcMs(pick.end.endHlc) >= SNAPSHOT_INTERVAL_MS) return true;
  // (h) : une suppression n'attend plus que son propre instantané couvrant.
  const ownEnd = candidates.find((c) => c.state.deviceId === deps.deviceId)?.end ?? 'none';
  const known = input.known();
  return [...input.view.order.keys()].some((target) => {
    if (target === deps.deviceId || input.view.done.has(target)) return false;
    const check = forgottenDeleteCheck(target, deps.deviceId, master, [...input.view.done], known, ownEnd);
    return check.kind === 'waiting' && check.reason === 'snapshot';
  });
}

export { maxEpoch };
