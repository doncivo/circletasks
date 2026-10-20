import { clearOrphanDeleteFailure, deleteOwnTracked } from './ownDeletion';
import type { DeviceAck, EpochId } from '../domain/sync/format';
import { hlcDevice } from '../domain/sync/parse';
import { isCycleInterrupted } from './deadline';
import type { DeviceScan, FolderScan } from '../platform/sync/types';
import { localBoundCovers, type LocalBound, type LocalBoundInput } from '../domain/sync/firstPublication';
import type { PublishBlockedCause, SyncStatusWarning } from '../domain/syncBanners';
import type { DeviceId } from '../domain/types';
import type { PublishedDeviceState } from '../domain/sync/format';
import { relistedOrphanEpochs } from '../domain/sync/orphanRelist';
import type { SyncDeps } from './deps';
import { queueOwnRowsForRepublish } from './epochSwitch';
import { META, readJson, writeJson } from './meta';
import type { Inflight } from './publisher';
import { syncErrorCodeOf, type SyncErrorCode } from '../platform/sync/types';

/**
 * Y-FIX-02 (ADR 0011 §30) : ce module porte aussi la reprise de l'état jamais écrit (exception `openedHere`, borne locale de la première
 * publication, intention d'ajout interrompue) et le journal `publish-deferred` (fin du fichier).
 *
 * Abandon d'une époque orpheline (ADR 0011 §24 point 4, étapes (a) à (c)). Module chargé **à la demande** par le moteur (cas rare : taille du
 * bundle de départ). Étapes idempotentes, reprises à l'étape interrompue :
 * (a) lignes remises dans la file d'envoi, traces purgées mémorisées (garde `orphan-trace-hit`), intention `orphanEpoch` ;
 * (b) `own.json` sans époque (Rust recontrôle la preuve) : `state-mismatch` annule l'abandon (rien n'est écrit) ;
 * (c) transaction locale : l'appareil n'a plus d'époque suivie, la reprise en fusion suit.
 */
export type AbandonResult = { readonly kind: 'done'; readonly rows: number } | { readonly kind: 'refused' } | { readonly kind: 'failed'; readonly code: SyncErrorCode };

export async function abandonOrphan(deps: SyncDeps, orphan: EpochId): Promise<AbandonResult> {
  const { data, platform, logger, deviceId: self } = deps;
  const repos = data.repos;
  const queued = await queueOwnRowsForRepublish(deps);
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
  try {
    await platform.abandonOrphanEpoch(orphan);
  } catch (error) {
    if (isCycleInterrupted(error)) throw error;
    const code = syncErrorCodeOf(error);
    logger.log('orphan-epoch-abandon-failed', { code });
    if (code !== 'state-mismatch') return { kind: 'failed', code };
    await writeJson(repos, META.orphanEpoch, null);
    await clearOrphanDeleteFailure(deps, orphan);
    return { kind: 'refused' };
  }
  await data.transaction(async (tx) => {
    await writeJson(tx, META.epoch, null);
    await writeJson(tx, META.head, null);
    await writeJson(tx, META.snapshot, null);
    await writeJson(tx, META.lastState, null);
    await writeJson(tx, META.resume, true);
    await tx.sync.saveState(self, { epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
  logger.log('epoch-abandoned', { epoch: orphan, rows: queued });
  return { kind: 'done', rows: queued };
}

/**
 * Point 4 (e) : fichiers de l'orpheline abandonnée, supprimés au mieux par `sync_delete_own` (l'époque n'est plus courante). Échec : journal avec
 * son code (comme les autres suppressions de l'étape 7), retenté à chaque cycle ; ni la lecture ni la publication n'attendent. Seule voie de
 * suppression, aussi pour une orpheline dont le mémo perdu a été réarmé par le moteur (`orphan-epoch-relisted`, Y-IOS-02-FIX-02, §24 point 10).
 */
export async function retryOrphanDeletion(deps: SyncDeps, ownScan: DeviceScan | null, currentEpoch: EpochId): Promise<void> {
  const { data, logger } = deps;
  const repos = data.repos;
  const left = await readJson<{ epoch: EpochId }>(repos, META.orphanEpoch);
  if (left === null || left.epoch === currentEpoch || (await readJson<EpochId>(repos, META.epoch)) === left.epoch) return;
  if (!ownScan?.epochs.some((e) => e.epoch === left.epoch)) {
    await writeJson(repos, META.orphanEpoch, null);
    await clearOrphanDeleteFailure(deps, left.epoch);
    logger.log('orphan-epoch-cleared', { epoch: left.epoch });
    return;
  }
  deps.deadline?.check('delete-own');
  const { deleted, code } = await deleteOwnTracked(deps, [{ epoch: left.epoch, kind: 'epoch' }], true);
  if (code === null) {
    if (deleted > 0) await writeJson(repos, META.orphanEpoch, null);
    // `orphan-epoch-deleted` seulement si un fichier a été retiré. Zéro ne prouve pas l'absence iCloud : le mémo reste et l'échec est visible,
    // même si l'événement historique `orphan-epoch-already-gone` indique qu'aucun fichier local n'a été retiré.
    if (deleted > 0) logger.log('orphan-epoch-deleted', { epoch: left.epoch });
    else logger.log('orphan-epoch-already-gone', { epoch: left.epoch.slice(0, 14) });
  } else {
    logger.log('orphan-epoch-delete-failed', { code });
  }
}

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : mémo `orphanEpoch` perdu (cause racine : substitut `.icloud` d'un fichier évincé que le plugin ne
 * supprimait pas) alors qu'une époque jamais annoncée ne garde que des instantanés dans son dossier : réarmé, puis supprimé par la voie unique
 * (`retryOrphanDeletion`). Jamais sans son propre état publié connu, jamais tant qu'un autre appareil non oublié a un état qui ne se lit pas
 * à ce scan (revue, point 2 : son annonce échapperait au contrôle, et `sync_delete_own` ne protège que l'époque courante) : illisible, dans
 * le nuage, en attente (`unreadable`), ou non accepté (étranger, rejoué, trop grand, version plus récente). Un dossier sans `state.ctx` ni
 * fichier n'annonce rien. Le moteur a déjà vérifié : aucune réinitialisation, mémo nul, au moins une époque candidate listée.
 */
export async function relistOrphanEpoch(
  deps: SyncDeps,
  input: {
    readonly scan: FolderScan;
    readonly ownScan: DeviceScan | null;
    readonly currentEpoch: EpochId;
    /** Son propre état publié (écrit dans ce cycle, sinon lu au scan). */
    readonly own: PublishedDeviceState | null;
    /** Époques des états acceptés des autres appareils et de leurs accusés sur soi. */
    readonly announced: readonly EpochId[];
    readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>;
    readonly forgotten: { has(id: DeviceId): boolean };
    /** Nombre d'appareils dont l'état ne se lit pas à ce scan (`unreadableDevices`). */
    readonly unreadable: number;
  },
): Promise<void> {
  const { data, logger, deviceId: self } = deps;
  const othersReadable =
    input.unreadable === 0 &&
    input.scan.devices.every((d) => d.deviceId === self || input.forgotten.has(d.deviceId) || input.accepted.has(d.deviceId) || (d.stateStatus === 'missing' && d.epochs.length === 0 && d.pending.length === 0));
  if (!othersReadable) return;
  const first = relistedOrphanEpochs({
    self,
    ownEpochs: input.ownScan?.epochs ?? [],
    currentEpoch: input.currentEpoch,
    localEpoch: await readJson<EpochId>(data.repos, META.epoch),
    ownAnnounced: input.own?.epoch ?? null,
    announced: input.announced,
  })[0];
  if (first === undefined) return;
  await writeJson(data.repos, META.orphanEpoch, { epoch: first });
  // Époque tronquée (numéro et 8 premiers caractères de l'ouvreur) : lisible dans l'export, jamais masquée comme un jeton.
  logger.log('orphan-epoch-relisted', { epoch: first.slice(0, 14) });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Y-FIX-02 (ADR 0011 §30) : reprise de l'état jamais écrit (instantané orphelin, segment écrit sans state.ctx) et journal de la décision
// ---------------------------------------------------------------------------------------------------------------------------------

/*
 * Chemins rares de la décision de publier, demandés par le moteur seulement quand la règle actuelle refuse de publier (`bound`,
 * `deferred`) ou qu'une intention d'ajout existe et que la publication est permise (`resolveInflight`). Ici plutôt que dans un bloc nouveau (bundle de départ, mesures de
 * Y-FIX-02) : un bloc nouveau qui importe `meta.ts` ou `epoch.ts` les sort de leur bloc de départ (+4 945 et +4 016 octets), et chaque bloc
 * nouveau ajoute son nom haché au départ ; la règle pure `localBoundCovers` n'importe que des types.
 */

/** Constats de la décision, construits une fois par le moteur (codes et compteurs seulement). */
export interface PublishFacts extends LocalBoundInput {
  /** Y-IOS-02 (`openedHere`) : époque ouverte ici dont l'état n'a jamais été écrit (instantané orphelin, preuve `isOrphanEpoch`). */
  readonly opened: boolean;
  readonly state: DeviceScan['stateStatus'] | undefined;
  readonly ignored: number;
  readonly acks: number;
}

type Logger = SyncDeps['logger'];

/**
 * Y-IOS-02 (`openedHere`, journal `own-state-recovered { epoch }`) puis Y-FIX-02 : borne locale (règle pure `localBoundCovers`) ; ouverte :
 * journal `own-state-recovered { epoch, source }`. `openedHere` implique son instantané compté : `canPublish` seul l'a refusé, c'est une reprise.
 */
// Contre-revue S3 : `source` n'est rendue que pour une borne ouverte (fermée : null), si bien que le moteur ne résout une intention par la
// borne que si `source === 'inflight'` (trace de l'époque courante), et ne nomme la cause d'un refus que si `source` n'est pas nulle.
export function bound(logger: Logger, facts: PublishFacts): LocalBound {
  if (facts.opened) {
    logger.log('own-state-recovered', { epoch: facts.currentEpoch });
    return { covers: true, source: null, unexplained: 0 };
  }
  const bound = localBoundCovers(facts);
  if (!bound.covers) return { ...bound, source: null };
  logger.log('own-state-recovered', { epoch: facts.currentEpoch, source: bound.source });
  return bound;
}

/** Y-IOS-02-FIX-02 : statut de son état propre dans `publish-deferred` quand son dossier n'apparaît pas au scan (liste fermée). */
const OWN_STATE_ABSENT = 'absent';

/**
 * Y-IOS-02-FIX-02 (critère 11), Y-FIX-02 (§30) : journal `publish-deferred` avec sa cause réelle, statuts et compteurs seulement (liste
 * fermée des statuts du scan, jamais de nom de fichier, de clé ni de chemin). `own-state-missing` : son état est connu comme absent ;
 * `first-publication-state-refused` : état refusé (ou `io`) pendant la première publication ouverte par la borne locale (trace `inflight`
 * ou `local-head` ; revue M1 : un refus de l'exception `openedHere`, `source` nulle, garde `state-refused`) ;
 * `unexplained-files` : fichier que la trace locale n'explique pas. La cause nommée est jointe à `warnings`, après `publish-blocked`.
 */
export function deferred(logger: Logger, refused: boolean, first: LocalBound | null, facts: PublishFacts, warnings: SyncStatusWarning[]): void {
  const state = facts.state ?? OWN_STATE_ABSENT;
  const cause: PublishBlockedCause | null = refused ? (first?.covers && first.source !== null ? 'first-publication-state-refused' : null) : first?.unexplained ? 'unexplained-files' : null;
  const reason = cause ?? (refused ? 'state-refused' : state === 'missing' || state === OWN_STATE_ABSENT ? 'own-state-missing' : 'own-state-unknown');
  logger.log('publish-deferred', { reason, state, files: facts.files, ignored: facts.ignored, acks: facts.acks, localSeq: facts.localSeq, ...(first?.unexplained ? { unexplained: first.unexplained } : {}) });
  if (cause) warnings.push(cause);
}

/**
 * Résout une intention d'ajout interrompue (arrêt entre l'ajout et le retrait de la file) : hypothèse « ajout réussi » d'abord. Y-FIX-02
 * (§30, revue B1) : appelée seulement si la publication est permise (sinon l'intention reste posée) ; Rust juge la tête. Acceptée : file retirée, `META.head` posé ;
 * refusée (`state-mismatch`, hypothèse « ajout manqué ») : file gardée, la publication reprend par l'existant ; `inflight` remis à nul dans
 * les deux cas. Une erreur (`io`) remonte avant la transaction : `inflight` est gardé pour le cycle suivant. Chemin rare (arrêt brutal) :
 * dans ce bloc à la demande depuis Y-FIX-02 (bundle de départ).
 */
export async function resolveInflight(deps: SyncDeps, inflight: Inflight, writeOwnState: (head: DeviceAck) => Promise<boolean>): Promise<void> {
  const head: DeviceAck = { epoch: inflight.epoch, segment: inflight.segment, record: inflight.expect + inflight.count, hlc: inflight.maxHlc, stateSeq: 0 };
  const ok = await writeOwnState(head);
  await deps.data.transaction(async (repos) => {
    if (ok) {
      await repos.sync.clearPublished(inflight.entries);
      await writeJson(repos, META.head, head);
      if ((await repos.sync.getMeta(META.publishRotation)) !== null) {
        const rotationModule = await import('./publishRotation');
        const rotation = await rotationModule.readPublishRotation(repos);
        if (rotation?.epoch === head.epoch && rotation.segment <= head.segment && head.hlc !== null && head.hlc >= rotation.maxHlc) await rotationModule.savePublishRotation(repos, null);
      }
    }
    await writeJson(repos, META.inflight, null);
  });
  deps.logger.log('inflight-resolved', { appended: ok });
}
