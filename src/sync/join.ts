import type { Repositories } from '../db/repositories';
import type { EpochId, PublishedDeviceState, SnapshotRecord } from '../domain/sync/format';
import type { DeviceId } from '../domain/types';
import { syncErrorCodeOf } from '../platform/sync/types';
import type { ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import type { CycleHooks } from './engine';
import { pickEligible, snapshotCandidates, type ForgetCoverage } from './eligible';
import { META, readJson, writeJson } from './meta';
import { cursorIds } from '../domain/sync/ownState';
import { positionFromCover } from '../domain/sync/positions';
import type { ResumeTried, SnapshotCandidate, SnapshotEnd } from '../domain/sync/retention';
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
 * Reprise en fusion d'un nouvel appareil (voir le module). Mêmes paramètres que `resumeFromSnapshot` ; rend si un instantané a été
 * appliqué en entier, et l'instantané essayé mémorisé (cinquième revue, point 1 ; undefined : inchangé).
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
): Promise<{ readonly applied: boolean; readonly tried: ResumeTried | undefined }> {
  const repos = deps.data.repos;
  const saved = await readJson<JoinState>(repos, JOIN_META);
  // Y-10 (§18 point 11, seconde revue point 1) : instantané **éligible** seulement (auteur non oublié, annoncé, couvrant chaque oublié
  // retenu jusqu'à sa coupure) ; jamais le plus récent par endHlc s'il ne l'est pas.
  const candidates = await snapshotCandidates(deps, epoch, [...accepted.values(), ...(ownState ? [ownState] : [])], coverage);
  if (candidates.length === 0) {
    // Aucun instantané dans l'époque : rien à suivre, l'appareil lit les journaux.
    if (saved !== null) await writeJson(repos, JOIN_META, null);
    deps.logger.log('resume-unavailable', { epoch });
    const none: ResumeTried = { epoch, author: null, seq: null };
    await writeJson(repos, META.resumeTried, none);
    return { applied: false, tried: none };
  }
  // Entrée de départ dès le premier cycle (revue 1) : une attente d'iCloud ou un arrêt avant la première tranche garde l'arrivée suivie.
  const start: JoinState = { epoch, from: deps.deviceId, seq: 0, done: 0, total: 0, failure: null };
  if (saved === null) await writeJson(repos, JOIN_META, start);
  let failure: JoinFailure | null = null;
  let tracked: JoinState = saved ?? start;
  const excluded = new Set<DeviceId>();
  const tried = triedTracker(candidates, coverage, epoch);
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
    if (!loaded) {
      tried.discarded(pick.end);
      continue;
    }
    if (!admitSnapshot(deps, loaded)) {
      tried.discarded(pick.end);
      // Instantané trop en avance (section 4.4) : écarté, son écrivain est signalé.
      if (deviceId !== deps.deviceId) await repos.sync.saveState(deviceId, { status: 'clock-ahead' });
      failure ??= 'clock-ahead';
      continue;
    }
    const same = saved !== null && saved.epoch === epoch && saved.from === deviceId && saved.seq === seq;
    tracked = { epoch, from: deviceId, seq, done: same ? Math.min(saved.done, loaded.records.length) : 0, total: loaded.end.count, failure: null };
    await writeJson(repos, JOIN_META, tracked);
    tried.applying(pick.end);
    try {
      await applyJoin(deps, deviceId, epoch, loaded, tracked, accepted, knows, hooks, coverage, tried.value());
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
    return { applied: true, tried: tried.value() };
  }
  await writeJson(repos, JOIN_META, { ...tracked, failure } satisfies JoinState);
  deps.logger.log('resume-unavailable', { epoch });
  await tried.save(repos);
  return { applied: false, tried: tried.value() };
}

/**
 * Dernière transaction d'une reprise depuis l'instantané (`resumeFromSnapshot`) et d'une arrivée (Y-TECH-02 : une seule fonction) :
 * curseurs aux positions `covers` (`cursorIds`, `positionFromCover` : une position d'une époque antérieure est gardée, accusé hérité,
 * jamais ramenée au début de l'époque courante), fin de la reprise (`sync_meta.resume`), et l'écrivain de l'instantané admis, écarté plus
 * tôt pour dérive, n'est plus en avance.
 */
export async function finishResumeTx(
  tx: Repositories,
  deps: SyncDeps,
  input: { readonly epoch: EpochId; readonly from: DeviceId; readonly loaded: LoadedSnapshot; readonly accepted: ReadonlyMap<DeviceId, unknown>; readonly coverage: ForgetCoverage; readonly tried?: ResumeTried | undefined },
): Promise<void> {
  const local = new Map((await tx.sync.getStates()).map((r) => [r.deviceId, r]));
  for (const id of cursorIds(input.accepted, deps.deviceId, input.loaded.end.covers, input.coverage.forgotten)) {
    await tx.sync.saveState(id, positionFromCover(input.loaded.end.covers.get(id as DeviceId), input.epoch, id === deps.deviceId, local.get(id)));
  }
  await writeJson(tx, META.resume, null);
  // Cinquième revue, point 1 : instantané essayé écrit avec la fin de la reprise (un arrêt brutal ensuite ne la rejoue pas pour un trou).
  if (input.tried) await writeJson(tx, META.resumeTried, input.tried);
  const source = (await tx.sync.getStates()).find((row) => row.deviceId === input.from);
  if (input.from !== deps.deviceId && source?.status === 'clock-ahead') await tx.sync.saveState(input.from, { status: 'active' });
}

/**
 * Cinquième revue, point 1 (ADR 0011 §5.5) : instantané **essayé** par une reprise = premier choix de `pickEligible` sans exclusion (le
 * plus récent éligible), mémorisé s'il est appliqué ou écarté définitivement (illisible, en avance) ; aucun éligible : `{époque, null,
 * null}` ; premier choix au corps en attente d'iCloud : inchangé (`value()` undefined). Jamais l'instantané finalement appliqué.
 */
export function triedTracker(candidates: readonly SnapshotCandidate[], coverage: ForgetCoverage, epoch: EpochId) {
  const first = pickEligible(candidates, coverage, epoch, new Set());
  let decided: ResumeTried | undefined = first.kind === 'none' ? { epoch, author: null, seq: null } : undefined;
  const isFirst = (end: SnapshotEnd): boolean => first.kind === 'ok' && first.end.author === end.author && first.end.seq === end.seq;
  const settle = (end: SnapshotEnd): void => {
    if (isFirst(end)) decided = { epoch, author: end.author, seq: end.seq };
  };
  return {
    /** Est-ce le premier choix (le plus récent éligible) ? */
    isFirst,
    /** Corps illisible ou instantané en avance : écarté définitivement. */
    discarded: settle,
    /** Appliqué (écrit par `finishResumeTx`, dans la dernière transaction). */
    applying: settle,
    value: (): ResumeTried | undefined => decided,
    /** Arrivée sans instantané appliqué : écrit hors transaction de fin (la demande de reprise reste posée, échec d'arrivée visible). */
    save: async (repos: Repositories): Promise<void> => {
      if (decided) await writeJson(repos, META.resumeTried, decided);
    },
    /**
     * Sixième revue, point 1 (ADR 0011 §5.5, « Reprise sûre ») : échec définitif d'une reprise hors arrivée (instantané essayé connu,
     * aucun premier choix en attente d'iCloud, aucune application commencée) : instantané essayé écrit et demande de reprise effacée dans
     * la même transaction ; chaque cause est ensuite réévaluée par sa propre règle visible. Sans essai connu : rien (demande gardée).
     */
    failDefinitively: async (data: SyncDeps['data']): Promise<void> => {
      const value = decided;
      if (!value) return;
      await data.transaction(async (tx) => {
        await writeJson(tx, META.resumeTried, value);
        await writeJson(tx, META.resume, null);
      });
    },
  };
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
  triedNow: ResumeTried | undefined,
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
    await finishResumeTx(tx, deps, { epoch, from: deviceId, loaded, accepted, coverage, tried: triedNow });
    await writeJson(tx, JOIN_META, null);
  };
  const result = await mergeSnapshot(deps, { records: records.slice(rowsEnd), end: loaded.end }, ctx, undefined, finalize);
  if (result === 'clock-ahead') throw new JoinError('clock-ahead');
  if (result.touched.size > 0) hooks.onRemoteChanges(result.touched);
  hooks.onProgress?.(total, total);
}
