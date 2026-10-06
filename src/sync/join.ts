import type { Repositories } from '../db/repositories';
import type { EpochId, PublishedDeviceState, SnapshotRecord } from '../domain/sync/format';
import type { DeviceId } from '../domain/types';
import { syncErrorCodeOf } from '../platform/sync/types';
import type { ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import type { CycleHooks } from './engine';
import { pickEligible, snapshotCandidates, type ForgetCoverage } from './eligible';
import { META, readJson, writeJson } from './meta';
import { admitSnapshot, loadSnapshot, mergeSnapshot, type LoadedSnapshot, type SnapshotTxHook } from './snapshot';

/**
 * Nouvel appareil (Y-06 critère 13 ; ADR 0011 sections 5.5 et 10.3) : un appareil qui vient d'importer la clé et n'a jamais suivi
 * d'époque rejoint le dossier par la **reprise depuis l'instantané en fusion** (rien n'est effacé, ses données locales sont gardées et
 * publiées ensuite), puis lit les journaux depuis `covers`.
 *
 * Ce que ce module ajoute à la reprise ordinaire (`resumeFromSnapshot`) :
 * - **progression** en enregistrements de l'instantané : `done / total`, `total` étant le nombre annoncé par `snap-end` ;
 * - **reprise au même endroit** : les lignes de l'instantané sont appliquées par tranches ; chaque tranche se termine par une transaction
 *   qui mémorise `done` dans `sync_meta.join` ; un arrêt au milieu ne rejoue que la tranche en cours (fusion idempotente) ;
 * - **échec visible et persistant** (exigence d'Ali) : un instantané refusé pour dérive d'horloge ou une erreur pendant l'application
 *   est mémorisé dans `sync_meta.join.failure` (code, jamais de contenu) jusqu'à la réussite, qui efface l'entrée ;
 *   l'interface le lit (`JoinProgress`). L'attente d'iCloud (instantané encore dans le nuage) et un instantané incomplet (les journaux suffisent) ne sont pas des échecs.
 *
 * Les curseurs et l'effacement de `sync_meta.resume` sont posés dans la **dernière** transaction, comme la reprise ordinaire.
 */

/** Clé de `sync_meta` (table locale, jamais publiée) ; lue telle quelle par `src/features/sync/JoinProgress.tsx`. */
export const JOIN_META = 'join';

/**
 * Enregistrements de l'instantané appliqués par tranche (une transaction de mémorisation par tranche). Un enregistrement `snap-rows` porte
 * jusqu'à 64 Kio de lignes : 4 enregistrements font des transactions de 256 Kio au plus, et un arrêt ne rejoue jamais plus de 256 Kio,
 * pour un coût fixe d'une écriture de `sync_meta` par tranche (5 000 tâches : une vingtaine de tranches).
 */
export const JOIN_CHUNK_RECORDS = 4;

/** Échec de l'arrivée qui porte son propre code (`clock-ahead`), gardé tel quel dans `sync_meta.join.failure`. */
export class JoinError extends Error {
  constructor(readonly code: JoinFailure) {
    super(`arrivée : ${code}`);
  }
}

/** `clock-ahead` : instantané refusé pour dérive d'horloge ; sinon le code de l'erreur survenue pendant l'application (`io`…). */
export type JoinFailure = 'clock-ahead' | (string & {});

/** Entrée `sync_meta.join` : instantané suivi, enregistrements appliqués, échec en cours (null : en cours ou en attente d'iCloud). */
export interface JoinState {
  readonly epoch: EpochId;
  readonly from: DeviceId;
  readonly seq: number;
  readonly done: number;
  readonly total: number;
  readonly failure: JoinFailure | null;
}

/**
 * Appareil en train de rejoindre : jamais d'époque suivie avant ce cycle, arrivée commencée et pas terminée, ou ligne de l'appareil sans
 * époque suivie (revue 1 : un arrêt entre la transaction qui pose l'époque et la première écriture de `join` ne fait pas basculer vers la
 * reprise ordinaire). L'époque de la ligne n'est posée que par la fin de l'arrivée (curseurs) ou par la publication ; `lastSyncAt` ne
 * convient pas : il reste nul tant que des fichiers attendent iCloud, même pour un appareil arrivé depuis longtemps.
 */
export async function isJoining(repos: Repositories, localEpoch: EpochId | null): Promise<boolean> {
  if (localEpoch === null || (await readJson<JoinState>(repos, JOIN_META)) !== null) return true;
  const self = (await repos.sync.getStates()).find((row) => row.isSelf);
  return !self?.epoch;
}

const isRowRecord = (record: SnapshotRecord): boolean => record.k === 'snap-rows' || record.k === 'snap-row';

/** Taille du préfixe de lignes (les traces, champs inconnus et `snap-end` suivent ; ils vont dans la dernière transaction). */
function rowPrefix(records: readonly SnapshotRecord[]): number {
  let n = 0;
  while (n < records.length && isRowRecord(records[n] as SnapshotRecord)) n += 1;
  return n;
}

/**
 * Reprise en fusion d'un nouvel appareil (voir le module). Mêmes paramètres et même résultat que `resumeFromSnapshot` : vrai si un
 * instantané a été appliqué en entier.
 */
export async function joinFromSnapshot(
  deps: SyncDeps,
  epoch: EpochId,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  ownState: PublishedDeviceState | null,
  knows: ApplyContext['knows'],
  hooks: CycleHooks,
  pending: Set<string>,
  coverage: ForgetCoverage,
): Promise<boolean> {
  const repos = deps.data.repos;
  const saved = await readJson<JoinState>(repos, JOIN_META);
  // Y-10 (§18 point 11, seconde revue point 1) : instantané **éligible** seulement (auteur non oublié, annoncé, couvrant chaque oublié
  // retenu jusqu'à sa coupure) ; jamais le plus récent par endHlc s'il ne l'est pas.
  const candidates = await snapshotCandidates(deps, epoch, [...accepted.values(), ...(ownState ? [ownState] : [])], coverage);
  if (candidates.length === 0) {
    // Aucun instantané dans l'époque : rien à suivre, l'appareil lit les journaux.
    if (saved !== null) await writeJson(repos, JOIN_META, null);
    deps.logger.log('resume-unavailable', { epoch });
    return false;
  }
  // Entrée de départ dès le premier cycle (revue 1) : une attente d'iCloud ou un arrêt avant la première tranche garde l'arrivée suivie.
  const start: JoinState = { epoch, from: deps.deviceId, seq: 0, done: 0, total: 0, failure: null };
  if (saved === null) await writeJson(repos, JOIN_META, start);
  let failure: JoinFailure | null = null;
  let tracked: JoinState = saved ?? start;
  const excluded = new Set<DeviceId>();
  for (const c of candidates) if (c.end === 'cloud-pending') pending.add(`${String(c.state.deviceId).slice(0, 8)}/${epoch}/snapshot`);
  for (;;) {
    const pick = pickEligible(candidates, coverage, epoch, excluded);
    if (pick.kind !== 'ok') {
      // Aucun éligible : attente visible (§14.2, « Aucun instantané à jour ») quand un candidat ne couvre pas un oublié ; l'attente
      // d'iCloud n'est pas un échec.
      if (pick.kind === 'none' && pick.uncovered !== null) {
        failure ??= 'state-mismatch';
        deps.logger.log('join-no-eligible-snapshot', { uncovered: pick.uncovered });
      }
      break;
    }
    const { author: deviceId, seq } = pick.end;
    excluded.add(deviceId);
    const loaded = await loadSnapshot(deps, deviceId, epoch, seq);
    if (loaded === 'cloud-pending') {
      pending.add(`${String(deviceId).slice(0, 8)}/${epoch}/snapshot`);
      continue;
    }
    // Instantané incomplet ou illisible : écarté (comme la reprise ordinaire) ; l'appareil lit alors les journaux, ce n'est pas un
    // blocage. Il est retenté au cycle suivant (`sync_meta.resume` reste posé).
    if (!loaded) continue;
    if (!admitSnapshot(deps, loaded)) {
      // Instantané trop en avance (section 4.4) : écarté, son écrivain est signalé.
      if (deviceId !== deps.deviceId) await repos.sync.saveState(deviceId, { status: 'clock-ahead' });
      failure ??= 'clock-ahead';
      continue;
    }
    const same = saved !== null && saved.epoch === epoch && saved.from === deviceId && saved.seq === seq;
    tracked = { epoch, from: deviceId, seq, done: same ? Math.min(saved.done, loaded.records.length) : 0, total: loaded.end.count, failure: null };
    await writeJson(repos, JOIN_META, tracked);
    try {
      await applyJoin(deps, deviceId, epoch, loaded, tracked, accepted, knows, hooks, coverage);
    } catch (error) {
      // Les tranches terminées ont mémorisé leur position : l'échec s'y ajoute sans la faire reculer.
      const reached = (await readJson<JoinState>(repos, JOIN_META)) ?? tracked;
      const code: JoinFailure = error instanceof JoinError ? error.code : syncErrorCodeOf(error);
      try {
        await writeJson(repos, JOIN_META, { ...reached, failure: code } satisfies JoinState);
      } catch (writeError) {
        // Base indisponible : l'échec du cycle reste visible par la phase `error` ; on le journalise sans contenu.
        deps.logger.log('join-failure-unsaved', { code: syncErrorCodeOf(writeError) });
      }
      throw error;
    }
    deps.logger.log('resumed-from-snapshot', { epoch, from: deviceId });
    return true;
  }
  await writeJson(repos, JOIN_META, { ...tracked, failure } satisfies JoinState);
  deps.logger.log('resume-unavailable', { epoch });
  return false;
}

/**
 * Appareils dont le curseur est posé à la fin d'une reprise : ceux dont l'état est accepté, soi, et chaque oublié retenu présent dans
 * `covers` (§18 point 11 : un appareil qui n'a jamais lu X publie l'accusé **hérité** de l'instantané dont il est parti).
 */
export function cursorIds(accepted: ReadonlyMap<DeviceId, unknown>, self: DeviceId, loaded: LoadedSnapshot, coverage: ForgetCoverage): Set<string> {
  const ids = new Set<string>([...accepted.keys(), self]);
  for (const id of loaded.end.covers.keys()) if (coverage.forgotten.has(id)) ids.add(id);
  return ids;
}

async function applyJoin(
  deps: SyncDeps,
  deviceId: DeviceId,
  epoch: EpochId,
  loaded: LoadedSnapshot,
  start: JoinState,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  knows: ApplyContext['knows'],
  hooks: CycleHooks,
  coverage: ForgetCoverage,
): Promise<void> {
  const records = loaded.records;
  const rowsEnd = rowPrefix(records);
  const total = loaded.end.count;
  const ctx = { localSv: deps.sv, remoteSv: loaded.end.sv, now: new Date(deps.clock.nowMs()).toISOString() as ApplyContext['now'], knows, logger: deps.logger };
  hooks.onProgress?.(start.done, total);
  // Lignes, par tranches : chaque tranche mémorise `done` dans sa dernière transaction.
  for (let from = Math.min(start.done, rowsEnd); from < rowsEnd; from += JOIN_CHUNK_RECORDS) {
    const to = Math.min(rowsEnd, from + JOIN_CHUNK_RECORDS);
    const chunk: LoadedSnapshot = { records: records.slice(from, to), end: loaded.end };
    const remember: SnapshotTxHook = (tx) => writeJson(tx, JOIN_META, { ...start, done: to, failure: null } satisfies JoinState);
    const result = await mergeSnapshot(deps, chunk, ctx, (doneOps, totalOps) => hooks.onProgress?.(from + Math.floor(((to - from) * doneOps) / Math.max(1, totalOps)), total), remember);
    if (result === 'clock-ahead') throw new JoinError('clock-ahead');
    if (result.touched.size > 0) hooks.onRemoteChanges(result.touched);
  }
  // Dernière transaction : traces, champs inconnus, curseurs aux positions `covers`, fin de la reprise et de l'arrivée.
  const finalize: SnapshotTxHook = async (tx) => {
    for (const id of cursorIds(accepted, deps.deviceId, loaded, coverage)) {
      const cover = loaded.end.covers.get(id as DeviceId);
      const inEpoch = cover && cover.epoch === epoch;
      await tx.sync.saveState(id, { epoch, cursorSegment: inEpoch ? cover.segment : 0, cursorRecord: inEpoch ? cover.record : 0, ackHlc: inEpoch ? cover.hlc : null });
    }
    await writeJson(tx, META.resume, null);
    await writeJson(tx, JOIN_META, null);
    const source = (await tx.sync.getStates()).find((row) => row.deviceId === deviceId);
    if (deviceId !== deps.deviceId && source?.status === 'clock-ahead') await tx.sync.saveState(deviceId, { status: 'active' });
  };
  const result = await mergeSnapshot(deps, { records: records.slice(rowsEnd), end: loaded.end }, ctx, undefined, finalize);
  if (result === 'clock-ahead') throw new JoinError('clock-ahead');
  if (result.touched.size > 0) hooks.onRemoteChanges(result.touched);
  hooks.onProgress?.(total, total);
}
