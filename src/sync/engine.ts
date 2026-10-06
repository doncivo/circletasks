import type { Repositories, SyncStateRow } from '../db/repositories';
import { DEVICE_EXPIRY_MS, MAX_STATE_ACKS, SNAPSHOT_INTERVAL_MS, SNAPSHOTS_KEPT_PER_EPOCH, STATE_REFRESH_MS, SYNC_FORMAT_MAJOR, compareEpochs, epochId, isDeviceAck, type DeviceAck, type EpochId, type PublishedDeviceState, type RecordCursor } from '../domain/sync/format';
import { compareVersions, newerKind } from '../domain/sync/compat';
import { canPublish, compareCursors, folderEpoch, maxEpoch, ownBounds } from '../domain/sync/epoch';
import { hlcIso, hlcMs, publishedStateToText } from '../domain/sync/parse';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { syncErrorCodeOf, type DeviceScan, type FolderScan, type SyncFolderInfo, type SyncDeviceStatus, type SyncErrorCode } from '../platform/sync/types';
import type { ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { switchEpoch } from './epochSwitch';
import { maintain, retryParked } from './maintenance';
import { META, readJson, writeJson } from './meta';
import { isJoining, joinFromSnapshot } from './join';
import { evaluateForget, finishRejoin, FORGET_META, forgetPublishPending, readLimit, rejoinPending, runForgetDeletions, type ForgetView } from './forget';
import { publishOutbox, readInflight } from './publisher';
import { readDevice } from './reader';
import { loadSnapshot, mergeSnapshot, snapshotPages } from './snapshot';
import type { CycleFacts } from './status';

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
}

export interface CycleResult extends CycleFacts {
  readonly folderLabel: string | null;
  readonly folderKind?: SyncFolderInfo['kind'] | null;
  readonly lastSyncAt: IsoDateTime | null;
  readonly worked: boolean;
}

const EMPTY: Omit<CycleResult, 'outcome'> = { errorCode: null, pendingFiles: [], devices: [], keyMismatch: false, folderLabel: null, folderKind: null, lastSyncAt: null, worked: false };

const ZERO: RecordCursor = { segment: 0, record: 0 };

export const iso = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

function parseAcks(json: string): Map<DeviceId, DeviceAck> {
  const out = new Map<DeviceId, DeviceAck>();
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    for (const [id, ack] of Object.entries(value)) if (isDeviceAck(ack)) out.set(id as DeviceId, ack);
  } catch {
    // accusés illisibles : aucun
  }
  return out;
}

function acksToJson(acks: ReadonlyMap<DeviceId, DeviceAck>): string {
  const out: Record<string, DeviceAck> = {};
  for (const [id, ack] of acks) out[id] = ack;
  return JSON.stringify(out);
}

/** Statut local d'un appareil d'après le statut de son `state.ctx` au scan (un état invalide garde son dernier accusé connu). */
function deviceStatusOf(scan: DeviceScan, previous: string | undefined): string {
  switch (scan.stateStatus) {
    case 'foreign':
      return 'foreign';
    case 'corrupt':
    case 'too-large':
      return 'corrupt';
    case 'rollback':
      return 'rollback';
    case 'newer-format':
      return 'newer-major';
    case 'ok':
      return scan.state && scan.state.sm > SYNC_FORMAT_MAJOR ? 'newer-major' : previous === 'clock-ahead' ? 'clock-ahead' : 'active';
    case 'missing':
    case 'cloud-pending':
      return previous ?? 'active';
  }
}

/** Accepte les états authentifiés des autres appareils dans `sync_state` (anti-rejeu local, section 1.4). */
async function acceptStates(deps: SyncDeps, scan: FolderScan, known: Map<string, SyncStateRow>): Promise<Map<DeviceId, PublishedDeviceState>> {
  const accepted = new Map<DeviceId, PublishedDeviceState>();
  for (const device of scan.devices) {
    if (device.deviceId === deps.deviceId) continue;
    const previous = known.get(device.deviceId);
    // Y-10 : un oubli ne s'annule pas ; le statut `forgotten` reste quel que soit l'état lu.
    let status = previous?.status === 'forgotten' ? 'forgotten' : deviceStatusOf(device, previous?.status);
    const state = device.stateStatus === 'ok' ? device.state : null;
    if (state) {
      const text = publishedStateToText(state);
      const rollback =
        previous !== undefined &&
        previous.stateSeq > 0 &&
        (state.stateSeq < previous.stateSeq || (state.stateSeq === previous.stateSeq && previous.stateDigest !== null && previous.stateDigest !== text) || (previous.stateEpoch !== null && compareEpochs(state.epoch, previous.stateEpoch as EpochId) < 0));
      if (rollback) {
        status = 'rollback';
      } else {
        if (status === 'forgotten') {
          // Y-10 : état gardé (ses accusés et ses déclarations comptent pour l'ordre total), statut inchangé.
        } else if (hlcMs(state.lastSyncHlc) < deps.clock.nowMs() - DEVICE_EXPIRY_MS) status = 'expired';
        // Corruption au milieu d'un segment sans instantané plus récent : l'appareil reste `corrupt` tant que sa tête ne bouge pas (section 5.5).
        else if (previous?.status === 'corrupt' && previous.headSegment === state.head.segment && previous.headRecord === state.head.record && previous.stateEpoch === state.epoch) status = 'corrupt';
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

export async function runCycle(deps: SyncDeps, hooks: CycleHooks, options: CycleOptions = {}): Promise<CycleResult> {
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

  // 0. Préconditions.
  if (!platform.available()) return { ...EMPTY, outcome: 'not-configured' };
  let folderLabel: string | null = null;
  let folderKind: SyncFolderInfo['kind'] | null = null;
  try {
    // Y-10 (D2) : « Associer de nouveau » interrompu avant que le dossier soit délié : terminé avant tout autre appel.
    if (await rejoinPending(repos)) {
      const rejoined = await finishRejoin(deps);
      if (rejoined.kind === 'failed') return fail(rejoined.code as SyncErrorCode);
    }
    const folder = await platform.folder.info();
    if (!folder.configured) return { ...EMPTY, outcome: 'not-configured' };
    folderLabel = folder.label;
    folderKind = folder.kind;
    const key = await platform.key.status();
    if (!key.present) return { ...EMPTY, folderLabel, folderKind, outcome: 'needs-pairing' };
    if (!options.ignoreMarker && (await platform.restoreMarker.get())) return { ...EMPTY, folderLabel, folderKind, outcome: 'restore-choice' };
    await platform.bindDevice(self);
  } catch (error) {
    return fail(syncErrorCodeOf(error), { folderLabel, folderKind });
  }

  // 1. scan.
  const known = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
  let scan: FolderScan;
  try {
    scan = await platform.scan({ keep: [...known.keys()].filter((id) => id !== self) as DeviceId[] });
  } catch (error) {
    return fail(syncErrorCodeOf(error), { folderLabel, folderKind });
  }
  await repos.sync.saveState(self, { isSelf: true, platform: deps.devicePlatform, appVersion: deps.appVersion, status: 'active' });
  const accepted = await acceptStates(deps, scan, known);
  const ownScan = scan.devices.find((d) => d.deviceId === self) ?? null;
  const ownState = ownScan?.stateStatus === 'ok' ? ownScan.state : null;
  const pending = new Set<string>(scan.devices.flatMap((d) => d.pending.map((p) => `${String(d.deviceId).slice(0, 8)}/${p.file}`)));

  // Y-10 : ordre total des oublis (déclarations des seuls états authentifiés). Appareil local oublié : il ne lit ni ne publie plus.
  let forgetView: ForgetView;
  try {
    forgetView = await evaluateForget(deps, { accepted, ownState, rows: await repos.sync.getStates() });
  } catch (error) {
    return fail(syncErrorCodeOf(error), { folderLabel, folderKind });
  }
  if (forgetView.selfForgotten) {
    logger.log('forgotten-self', { by: forgetView.order.get(self)?.by ?? null });
    return { ...EMPTY, outcome: 'forgotten', folderLabel, folderKind, devices: await deviceStatuses(repos, self, accepted, deps.sv) };
  }
  const others = scan.devices.filter((d) => d.deviceId !== self && !forgetView.order.has(d.deviceId));
  const keyMismatch = others.length > 0 && others.every((d) => d.stateStatus === 'foreign');

  // 2. Règle 1 : bornes de sa propre publication.
  const acksOnSelf = [...accepted.values()].map((s) => s.acks.get(self)).filter((a): a is DeviceAck => a !== undefined);
  const localEpoch = await readJson<EpochId>(repos, META.epoch);
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
    // Y-10 : liste déjà publiée ; Rust (maître) la complète de ses déclarations confirmées et pas encore publiées.
    forgotten: ownState?.forgotten ?? [],
    reset: null,
  });

  /** Y-10 : déclaration confirmée à publier (intention posée avant l'appel à Rust). */
  let publishForget = await forgetPublishPending(repos);
  /** Dernier état écrit dans ce cycle (suppression des fichiers d'un appareil oublié : Rust relit son état sur le disque). */
  let lastWritten: PublishedDeviceState | null = null;

  /** Écrit son `state.ctx` ; renvoie faux sur `state-mismatch` (hypothèse refusée par Rust). */
  const writeState = async (state: PublishedDeviceState, force: boolean): Promise<boolean> => {
    const comparable = publishedStateToText({ ...state, stateSeq: 0, head: { ...state.head, stateSeq: 0 }, lastSyncHlc: '000000000000000-0000-00000000-0000-4000-8000-000000000000' as Hlc, forgotten: [] });
    const forced = force || publishForget;
    if (!forced && lastStateMeta && lastStateMeta.text === comparable && deps.clock.nowMs() - lastStateMeta.at < STATE_REFRESH_MS && ownState !== null) return true;
    try {
      await platform.writeState({ sv: deps.sv, state });
      stateSeq = state.stateSeq;
      await data.transaction(async (tx) => {
        await writeJson(tx, META.stateSeq, state.stateSeq);
        await writeJson(tx, META.lastState, { text: comparable, at: deps.clock.nowMs() });
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
    const states = [...accepted.values()];
    const folderE = folderEpoch([...states, ...(ownState ? [ownState] : [])]);
    let epoch = localEpoch;
    let resume = options.forceResume === true || (await readJson<boolean>(repos, META.resume)) === true;
    const selfRow = known.get(self);
    if (selfRow?.lastSyncAt && Date.parse(selfRow.lastSyncAt) < deps.clock.nowMs() - DEVICE_EXPIRY_MS) resume = true;

    const switchState = await readJson<{ target: EpochId }>(repos, META.epochSwitch);
    if (epoch === null && folderE === null) {
      // Premier appareil : ouverture de l'époque 1 (instantané complet, puis état).
      epoch = epochId(1, self);
      work();
      const maxSeq = await repos.sync.maxOutboxSeq();
      const endHlc = deps.hlc.now();
      await platform.writeSnapshot({ epoch, seq: 1, sv: deps.sv, records: snapshotPages(repos, epoch, new Map<DeviceId, DeviceAck>(), deps.sv) });
      const head: DeviceAck = { epoch, segment: 0, record: 0, hlc: null, stateSeq: 0 };
      await data.transaction(async (tx) => {
        await tx.sync.clearOutbox(maxSeq);
        await writeJson(tx, META.epoch, epoch);
        await writeJson(tx, META.head, head);
        await writeJson(tx, META.snapshot, { epoch, seq: 1, endHlc });
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
    } else if (epoch !== null && ((folderE !== null && compareEpochs(folderE, epoch) > 0) || switchState)) {
      const target = switchState?.target ?? (folderE as EpochId);
      work();
      const switched = await switchEpoch(deps, target, accepted, ownState, hooks.onRemoteChanges);
      if (switched !== 'done') {
        if (switched === 'cloud-pending') pending.add(`${target}/snapshot`);
        // 'clock-ahead' : l'ouvreur est signalé (phase « horloge en avance »), le changement attend que la condition cesse.
        const waiting = switched === 'cloud-pending' || switched === 'clock-ahead';
        return { ...EMPTY, outcome: waiting ? 'done' : 'failed', errorCode: waiting ? null : 'io', pendingFiles: [...pending], folderLabel, folderKind, worked, devices: await deviceStatuses(repos, self, accepted, deps.sv) };
      }
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
    const publishAllowed = canPublish({
      ownStateOk: ownState !== null,
      acksOnSelf: acksOnSelf.length,
      listedFiles: (ownScan?.epochs ?? []).reduce((n, e) => n + e.segments.length + e.snapshots.length, 0),
      localStateSeq: localSeq,
    }) || ownScan?.stateStatus === 'foreign' || ownScan?.stateStatus === 'corrupt';
    let head: DeviceAck = { epoch: currentEpoch, segment: bounds.head.segment, record: bounds.head.record, hlc: bounds.headHlc, stateSeq: 0 };
    const storedSnapshot = await readJson<{ epoch: EpochId; seq: number; endHlc: Hlc }>(repos, META.snapshot);
    let snapshotMeta = storedSnapshot?.epoch === currentEpoch ? { seq: storedSnapshot.seq, endHlc: storedSnapshot.endHlc } : null;
    const purgeHorizon = await readJson<Hlc>(repos, META.purgeHorizon);
    const ackMap = async (): Promise<Map<DeviceId, DeviceAck>> => {
      const rows = await repos.sync.getStates();
      const acks = new Map<DeviceId, DeviceAck>();
      for (const row of rows) {
        if (row.isSelf || row.epoch !== currentEpoch || acks.size >= MAX_STATE_ACKS) continue;
        acks.set(row.deviceId as DeviceId, { epoch: currentEpoch, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: row.stateSeq });
      }
      return acks;
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
    const knows = await knowsFrom(repos);
    let resumed = false;
    const doResume = async (): Promise<boolean> => {
      resumed = true;
      work();
      // Reprise mémorisée avant toute modification ; effacée par la dernière transaction de la reprise (avec les curseurs).
      await writeJson(repos, META.resume, true);
      // Y-06 : un nouvel appareil (aucune époque suivie avant ce cycle, ou arrivée commencée) rejoint par tranches, avec progression,
      // reprise au même endroit et échec mémorisé (src/sync/join.ts) ; les autres reprises sont inchangées.
      if (await isJoining(repos, localEpoch)) return joinFromSnapshot(deps, currentEpoch, accepted, ownState, knows, hooks, pending);
      return resumeFromSnapshot(deps, currentEpoch, accepted, ownState, knows, hooks, pending);
    };
    if (resume) await doResume();

    let allRead = true;
    for (let pass = 0; pass < 2; pass += 1) {
      let needResume = false;
      const truncated: string[] = [];
      allRead = true;
      const rows = new Map((await repos.sync.getStates()).map((row) => [row.deviceId, row]));
      const targets: { id: DeviceId; head: DeviceAck; epochListing: DeviceScan['epochs'][number] | undefined; limit?: DeviceAck }[] = [];
      for (const [id, state] of accepted) {
        const row = rows.get(id);
        const epochListing = scan.devices.find((d) => d.deviceId === id)?.epochs.find((e) => e.epoch === currentEpoch);
        if (forgetView.order.has(id)) {
          // Y-10 : appareil oublié, lu jusqu'à la coupure (maximum des accusés des appareils actifs et de sa position locale), jamais au-delà.
          const local: DeviceAck | null = row?.epoch === currentEpoch ? { epoch: currentEpoch, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: 0 } : null;
          const limit = readLimit(id, forgetView, accepted, ownState, local);
          if (state.epoch !== currentEpoch || limit === null || limit.epoch !== currentEpoch) continue;
          const head = compareCursors(state.head, limit) <= 0 ? state.head : { ...state.head, segment: limit.segment, record: limit.record };
          targets.push({ id, head, epochListing, limit });
          continue;
        }
        if (state.epoch !== currentEpoch || row?.status === 'foreign' || row?.status === 'newer-major' || row?.status === 'rollback' || row?.status === 'corrupt') {
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
        const cursor: RecordCursor = row?.epoch === currentEpoch ? { segment: row.cursorSegment, record: row.cursorRecord } : ZERO;
        if (row?.epoch !== currentEpoch) await repos.sync.saveState(target.id, { epoch: currentEpoch, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
        if (compareCursors(cursor, target.head) >= 0) continue;
        // Segment nécessaire disparu (purgé) : reprise depuis l'instantané.
        const minListed = Math.min(...(target.epochListing?.segments ?? [Infinity]));
        if (cursor.segment > 0 && Number.isFinite(minListed) && cursor.segment < minListed) {
          needResume = true;
          continue;
        }
        if (cursor.segment === 0 && Number.isFinite(minListed) && minListed > 1) {
          needResume = true;
          continue;
        }
        work();
        const outcome = await readDevice(deps, {
          deviceId: target.id,
          epoch: currentEpoch,
          cursor,
          ackHlc: row?.epoch === currentEpoch ? row.ackHlc : null,
          knows,
          onBatch: hooks.onRemoteChanges,
          ...(target.limit ? { limit: target.limit } : {}),
        });
        if (outcome.status !== 'complete') allRead = false;
        if (outcome.status === 'cloud-pending') pending.add(`${String(target.id).slice(0, 8)}/${currentEpoch}`);
        if (outcome.status === 'truncated') {
          if (resumed) await repos.sync.saveState(target.id, { status: 'corrupt' });
          else {
            needResume = true;
            truncated.push(target.id);
          }
        }
        if (target.id !== self && !forgetView.order.has(target.id)) {
          const status = outcome.status === 'truncated' ? (resumed ? 'corrupt' : undefined) : outcome.status === 'clock-ahead' ? 'clock-ahead' : outcome.status === 'newer-major' ? 'newer-major' : outcome.status === 'foreign' ? 'foreign' : row?.status === 'clock-ahead' ? 'active' : undefined;
          if (status) await repos.sync.saveState(target.id, { status });
        }
      }
      if (!needResume || resumed) break;
      if (!(await doResume())) {
        // Aucun instantané lisible : les appareils corrompus le restent, les autres sont lus normalement.
        for (const id of truncated) await repos.sync.saveState(id, { status: 'corrupt' });
        break;
      }
    }

    // Opérations mises de côté (parent ou ligne arrivés depuis) : retentées après la lecture.
    if ((await repos.sync.parkedCount(['missing-parent', 'missing-row'])) > 0) {
      const retried = await retryParked(deps);
      if (retried.size > 0) hooks.onRemoteChanges(retried);
    }

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
    }

    // 6. État publié (réécrit s'il a changé, ou s'il a été remplacé par un tiers).
    const forceState = ownScan?.stateStatus === 'foreign' || ownScan?.stateStatus === 'corrupt' || ownState?.epoch !== currentEpoch;
    if (publishAllowed) await writeState(await nextState(head), forceState);

    // 7. Entretien : instantané si dû, purges, plafonds.
    if (publishAllowed && allRead && publishError === null) {
      const lastSnapshotMs = Math.max(
        snapshotMeta ? hlcMs(snapshotMeta.endHlc) : 0,
        ...states.filter((s) => s.epoch === currentEpoch && s.snapshot).map((s) => hlcMs((s.snapshot as { endHlc: Hlc }).endHlc)),
      );
      if (deps.clock.nowMs() - lastSnapshotMs >= SNAPSHOT_INTERVAL_MS) {
        work();
        const listedSnapshots = listed?.snapshots ?? [];
        const seq = Math.max(snapshotMeta?.seq ?? 0, ...listedSnapshots) + 1;
        const covers = await ackMap();
        covers.set(self, { ...head, stateSeq: stateSeq });
        const endHlc = deps.hlc.now();
        await platform.writeSnapshot({ epoch: currentEpoch, seq, sv: deps.sv, records: snapshotPages(repos, currentEpoch, covers, deps.sv) });
        snapshotMeta = { seq, endHlc };
        await writeJson(repos, META.snapshot, { epoch: currentEpoch, ...snapshotMeta, coveredSegment: head.segment });
        await writeState(await nextState(head), true);
        const old = [...listedSnapshots, seq].sort((a, b) => b - a).slice(SNAPSHOTS_KEPT_PER_EPOCH);
        if (old.length > 0) await platform.deleteOwn(old.map((n) => ({ epoch: currentEpoch, kind: 's' as const, n }))).catch(() => 0);
        logger.log('snapshot-written', { epoch: currentEpoch, seq });
      }
      await maintain(deps, { epoch: currentEpoch, head, accepted, ownScan, rows: await repos.sync.getStates() });
    }

    // Y-10 : suppression des fichiers des appareils oubliés (conditions de Rust vérifiées d'abord, aucune boîte).
    if (publishAllowed && forgetView.order.size > 0) await runForgetDeletions(deps, { view: forgetView, scan, accepted, ownPublished: lastWritten ?? ownState });

    // 8. Heure de dernière synchro.
    const lastSyncAt = iso(deps.clock.nowMs());
    if (publishError === null && pending.size === 0) await repos.sync.saveState(self, { lastSyncAt });
    const devices = await deviceStatuses(repos, self, accepted, deps.sv);
    if (publishError !== null) return { ...EMPTY, outcome: 'failed', errorCode: publishError as SyncErrorCode, pendingFiles: [...pending], devices, folderLabel, folderKind, worked, keyMismatch };
    return { outcome: 'done', errorCode: null, pendingFiles: [...pending], devices, keyMismatch, folderLabel, folderKind, lastSyncAt: pending.size === 0 ? lastSyncAt : (selfRow?.lastSyncAt ?? null), worked };
  } catch (error) {
    logger.log('cycle-error', { code: syncErrorCodeOf(error) });
    return fail(syncErrorCodeOf(error), { folderLabel, folderKind, pendingFiles: [...pending] });
  }
}

/** Accusés publiés par chaque appareil : le suppresseur avait-il lu l'écriture `hlc` de `device` ? */
async function knowsFrom(repos: Repositories): Promise<ApplyContext['knows']> {
  const acks = new Map<string, Map<DeviceId, DeviceAck>>();
  for (const row of await repos.sync.getStates()) acks.set(row.deviceId, parseAcks(row.lastAcks));
  return (deleter, device, hlc) => {
    const ack = acks.get(deleter)?.get(device);
    return ack !== undefined && ack.hlc !== null && ack.hlc >= hlc;
  };
}

/**
 * Appareils affichés (APPAREILS) et, Y-07 critère 11, leur version d'après `sync_state` : `newer` = `'major'` pour une majeure
 * supérieure (statut `newer-major`, lecture suspendue), `'schema'` pour un `sv` supérieur de même majeure (`compat.ts`), sinon null ;
 * `appVersion` = numéro d'application publié, null quand il n'est plus à jour (état d'une majeure supérieure illisible : la ligne garde
 * le numéro de l'état précédent).
 */
async function deviceStatuses(repos: Repositories, self: DeviceId, accepted: ReadonlyMap<DeviceId, PublishedDeviceState>, localSv: number): Promise<SyncDeviceStatus[]> {
  const rows = await repos.sync.getStates();
  return rows
    .filter((row) => row.isSelf || accepted.has(row.deviceId as DeviceId) || row.stateSeq > 0)
    .map((row): SyncDeviceStatus => {
      const isSelf = row.deviceId === self;
      const status = (['active', 'expired', 'newer-major', 'clock-ahead', 'corrupt', 'foreign', 'rollback', 'forgotten'].includes(row.status) ? row.status : 'active') as SyncDeviceStatus['status'];
      const relation = compareVersions({ sm: SYNC_FORMAT_MAJOR, sv: localSv }, { sm: row.formatMajor, sv: row.schemaVersion });
      const stale = status === 'newer-major' && relation !== 'newer-major';
      return {
        deviceId: row.deviceId as DeviceId,
        platform: row.platform === 'ios' ? 'ios' : 'windows',
        self: isSelf,
        lastReadAt: isSelf ? row.lastSyncAt : row.ackHlc ? hlcIso(row.ackHlc) : null,
        status,
        // Champs Y-07 pour les autres appareils seulement (soi : sans objet ; les comparaisons existantes de la ligne de soi restent vraies).
        ...(isSelf ? {} : { appVersion: stale ? null : row.appVersion, newer: status === 'newer-major' ? 'major' : newerKind(relation) }),
      };
    })
    .sort((a, b) => (a.self === b.self ? (a.deviceId < b.deviceId ? -1 : 1) : a.self ? -1 : 1));
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
): Promise<boolean> {
  const candidates = [...accepted.entries(), ...(ownState ? [[deps.deviceId, ownState] as const] : [])]
    .filter(([, s]) => s.epoch === epoch && s.snapshot !== null)
    .sort(([, a], [, b]) => ((a.snapshot?.endHlc ?? '') < (b.snapshot?.endHlc ?? '') ? 1 : -1));
  for (const [deviceId, state] of candidates) {
    const loaded = await loadSnapshot(deps, deviceId, epoch, (state.snapshot as { seq: number }).seq);
    if (loaded === 'cloud-pending') {
      pending.add(`${String(deviceId).slice(0, 8)}/${epoch}/snapshot`);
      continue;
    }
    if (!loaded) continue;
    const now = iso(deps.clock.nowMs());
    const result = await mergeSnapshot(deps, loaded, { localSv: deps.sv, remoteSv: loaded.end.sv, now, knows, logger: deps.logger }, hooks.onProgress, async (tx) => {
      // Curseurs aux positions couvertes (époque courante), sinon depuis le début.
      for (const id of new Set<string>([...accepted.keys(), deps.deviceId])) {
        const cover = loaded.end.covers.get(id as DeviceId);
        const inEpoch = cover && cover.epoch === epoch;
        await tx.sync.saveState(id, { epoch, cursorSegment: inEpoch ? cover.segment : 0, cursorRecord: inEpoch ? cover.record : 0, ackHlc: inEpoch ? cover.hlc : null });
      }
      await writeJson(tx, META.resume, null);
      // Instantané admis : son écrivain, écarté plus tôt pour dérive, n'est plus en avance.
      const source = (await tx.sync.getStates()).find((row) => row.deviceId === deviceId);
      if (deviceId !== deps.deviceId && source?.status === 'clock-ahead') await tx.sync.saveState(deviceId, { status: 'active' });
    });
    if (result === 'clock-ahead') {
      // Instantané trop en avance (section 4.4) : écarté ; l'appareil qui l'a écrit est signalé.
      if (deviceId !== deps.deviceId) await deps.data.repos.sync.saveState(deviceId, { status: 'clock-ahead' });
      continue;
    }
    if (result.touched.size > 0) hooks.onRemoteChanges(result.touched);
    deps.logger.log('resumed-from-snapshot', { epoch, from: deviceId });
    return true;
  }
  deps.logger.log('resume-unavailable', { epoch });
  return false;
}

export { maxEpoch };
