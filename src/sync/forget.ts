import type { Repositories, SyncStateRow } from '../db/repositories';
import { parseStoredAcks } from '../domain/sync/stored';
import { isSyncDeviceId, type DeviceAck, type ForgottenDevice, type PublishedDeviceState } from '../domain/sync/format';
import { PAGE_ROWS } from '../domain/sync/limits';
import { hlcDevice } from '../domain/sync/parse';
import { compareAckPositions, cutoff, forgetOrder, forgottenDeleteCheck, publishedEpochs, seenDevices, withoutStaleAcks, type ForgetKnownDevice, type ForgetVerdict, type SnapshotEndRead } from '../domain/sync/retention';
import { SYNC_TABLES } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import {
  syncErrorCodeOf,
  type FolderScan,
  type ForgetDeletionStatus,
  type ForgetFailure,
  type ForgetOutcome,
  type ForgetStep,
  type ForgottenRegistryView,
  type RejoinOutcome,
  type SyncForgetStatus,
} from '../platform/sync/types';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { META, readJson, writeJson } from './meta';

/**
 * Oubli d'un appareil (Y-10 ; ADR 0011 sections 14.2, 1.4 et 18) : partie moteur.
 *
 * - **Déclaration** (`declareForget`) : intention `forgetPublish` posée avant l'appel à Rust (`sync_device_forget`, confirmation
 *   native), puis le cycle republie son `state.ctx` (Rust complète la liste `forgotten` dont il est maître). Un arrêt à n'importe quel
 *   instant reprend : l'intention force une publication au cycle suivant, `forgotten.json` (Rust) fait foi.
 * - **Ordre total** (`evaluateForget`, au début de chaque cycle) : déclarations lues dans les seuls états **authentifiés** (D5 : un
 *   `forgotten` d'un état `foreign`, `corrupt` ou `rollback` est ignoré), gardées dans `sync_meta.forgetDeclarations` (un oubli ne
 *   s'annule pas : un état devenu illisible ne le retire pas), statut `forgotten` des appareils oubliés ; appareil local oublié : phase
 *   `forgotten`, il cesse de lire et de publier (file gardée).
 * - **Coupure** (`readLimit`) : un appareil oublié n'est lu que jusqu'au maximum des accusés des appareils actifs (et de sa propre
 *   position), jamais au-delà.
 * - **Suppression** (`runForgetDeletions`, fin de cycle) : mêmes conditions que Rust (`forgottenDeleteCheck`), appel de
 *   `sync_forgotten_delete` seulement quand elles sont réunies ; « suppression des fichiers en attente de {appareil} » gardée dans
 *   `sync_meta.forgetDeletions`.
 * - **Aucun échec silencieux** (exigence d'Ali) : tout refus ou erreur de Rust est écrit dans `sync_meta.forgetFailure` (appareil, code,
 *   heure, étape ; jamais de contenu, de clé ni de chemin), lu par `status().forget`, effacé seulement à la réussite de la même étape.
 * - **Associer de nouveau** (`prepareRejoin`, D2) : écritures propres non lues des autres (au-delà de la coupure) rattachées à la
 *   nouvelle identité et remises dans la file, nouvel identifiant, dossier délié (clé gardée) ; l'app est ensuite relancée.
 *
 * Journal technique : `forget-declared`, `forget-applied`, `forgotten-delete` et leurs échecs (identifiants d'appareil, codes, nombres).
 */

/** Clés de `sync_meta` propres à Y-10 (table locale, jamais publiée). */
export const FORGET_META = {
  /** Cache de la liste maître rendue par le dernier scan (`FolderScan.forgotten.entries`) : jamais une source d'oubli (§18 point 3). */
  declarations: 'forgetDeclarations',
  /** Dernier échec (`ForgetFailure`), effacé à la réussite. */
  failure: 'forgetFailure',
  /** Suppressions des fichiers des appareils oubliés (`ForgetDeletionStatus[]`). */
  deletions: 'forgetDeletions',
  /** Publication de la liste `forgotten` à forcer (déclaration demandée à Rust). */
  publish: 'forgetPublish',
  /** « Associer de nouveau » en cours : dossier à délier avant tout autre appel (`{ from, to }`). */
  rejoin: 'rejoin',
  /**
   * Oublis annulés (§18 point 12) : `{ deviceId, done }[]`, appareils qui étaient oubliés et ne le sont plus selon l'ordre total, gardés
   * jusqu'à un nouvel oubli (« oubli en échec ») ; `done` : terminé, jamais relu, horizon de purge `blocked` (lu aussi au démarrage).
   */
  revived: 'forgetRevived',
  /** Aucun instantané éligible pour reprendre, ou trou sur un oublié (§18 point 11) : `{ target }`, visible jusqu'à la résolution. */
  snapshotWait: 'forgetSnapshotWait',
} as const;

/** Oubli annulé gardé dans `sync_meta`. */
export interface RevivedDevice {
  readonly deviceId: DeviceId;
  readonly done: boolean;
}

export function parseRevived(value: unknown): RevivedDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RevivedDevice[] => (isRecord(item) && isSyncDeviceId(item['deviceId']) && typeof item['done'] === 'boolean' ? [{ deviceId: item['deviceId'], done: item['done'] }] : []));
}

/** Terminés dont l'oubli est annulé (horizon de purge `blocked`, section 5.4) : lus aussi hors cycle (corbeille au démarrage). */
export async function revivedDone(repos: Repositories): Promise<DeviceId[]> {
  return parseRevived(await readJson<unknown>(repos, FORGET_META.revived)).filter((r) => r.done).map((r) => r.deviceId);
}

/** Attente d'un instantané éligible (§18 point 11) : posée ou effacée par le cycle ; rien écrit si elle ne change pas. */
export async function setSnapshotWait(deps: SyncDeps, target: DeviceId | null): Promise<void> {
  const current = await readJson<{ target: DeviceId }>(deps.data.repos, FORGET_META.snapshotWait);
  if ((current?.target ?? null) === target) return;
  await writeJson(deps.data.repos, FORGET_META.snapshotWait, target === null ? null : { target });
  deps.logger.log(target === null ? 'forget-snapshot-wait-cleared' : 'forget-snapshot-wait', target === null ? {} : { device: target });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lecture défensive de sync_meta
// ---------------------------------------------------------------------------------------------------------------------------------

const STEPS: readonly ForgetStep[] = ['declare', 'delete', 'rejoin', 'overflow'];
const DELETION_STATES: readonly ForgetDeletionStatus['state'][] = ['waiting', 'deleting', 'finalizing', 'no-snapshot', 'strays', 'done'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseForgetFailure(value: unknown): ForgetFailure | null {
  if (!isRecord(value)) return null;
  const { deviceId, code, at, step } = value;
  if (!isSyncDeviceId(deviceId) || typeof code !== 'string' || !/^[a-z-]{1,32}$/.test(code) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (!STEPS.includes(step as ForgetStep)) return null;
  return { deviceId, code, at: at as IsoDateTime, step: step as ForgetStep };
}

export function parseForgetDeletions(value: unknown): ForgetDeletionStatus[] {
  if (!Array.isArray(value)) return [];
  const out: ForgetDeletionStatus[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isSyncDeviceId(item['deviceId']) || !DELETION_STATES.includes(item['state'] as ForgetDeletionStatus['state'])) continue;
    const waitingFor = item['waitingFor'];
    out.push({ deviceId: item['deviceId'], state: item['state'] as ForgetDeletionStatus['state'], waitingFor: isSyncDeviceId(waitingFor) ? waitingFor : null });
  }
  return out;
}

/** État Y-10 affiché (`SyncStatus.forget`) : échec et suppressions en cours (les suppressions terminées ne sont plus montrées). */
export async function readForgetStatus(repos: Repositories): Promise<SyncForgetStatus | null> {
  const failure = parseForgetFailure(await readJson<unknown>(repos, FORGET_META.failure));
  const stored = parseForgetDeletions(await readJson<unknown>(repos, FORGET_META.deletions)).filter((d) => d.state !== 'done');
  // Aucun instantané éligible (§18 point 11) : montré en premier, sur la ligne de l'oublié non couvert.
  const wait = await readJson<{ target?: unknown }>(repos, FORGET_META.snapshotWait);
  const deletions: ForgetDeletionStatus[] = isSyncDeviceId(wait?.target) ? [{ deviceId: wait.target, state: 'no-snapshot', waitingFor: null }, ...stored] : stored;
  const revived = parseRevived(await readJson<unknown>(repos, FORGET_META.revived)).map((r) => r.deviceId);
  return failure === null && deletions.length === 0 && revived.length === 0 ? null : { failure, deletions, revived };
}

async function recordFailure(deps: SyncDeps, deviceId: DeviceId, step: ForgetStep, code: string): Promise<void> {
  const failure: ForgetFailure = { deviceId, code, at: new Date(deps.clock.nowMs()).toISOString() as IsoDateTime, step };
  await writeJson(deps.data.repos, FORGET_META.failure, failure);
  deps.logger.log(`forget-${step}-failed`, { device: deviceId, code });
}

/** Efface l'échec s'il concerne une des étapes données pour le même appareil (réussite, ou cible devenue sans objet). */
async function clearFailure(repos: Repositories, deviceId: DeviceId, steps: readonly ForgetStep[]): Promise<void> {
  const failure = parseForgetFailure(await readJson<unknown>(repos, FORGET_META.failure));
  if (failure && failure.deviceId === deviceId && steps.includes(failure.step)) await writeJson(repos, FORGET_META.failure, null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Déclaration (critères 3, 6, 14, 15)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * « Oublier cet appareil » confirmé dans l'app : intention mémorisée, appel à Rust (confirmation native), puis l'appelant lance les
 * cycles qui publient et appliquent l'oubli. `consent-denied` : annulation volontaire, rien n'est écrit ni gardé ; tout autre refus ou
 * erreur : `forgetFailure`, rendu à l'appelant. En cas d'échec, l'intention reprend sa valeur précédente (revue Y-10, point 7 : une
 * déclaration antérieure pas encore publiée le reste).
 */
export async function declareForget(deps: SyncDeps, deviceId: DeviceId): Promise<ForgetOutcome> {
  const previous = await readJson<boolean>(deps.data.repos, FORGET_META.publish);
  await writeJson(deps.data.repos, FORGET_META.publish, true);
  try {
    await deps.platform.forget.device(deviceId);
  } catch (error) {
    const code = syncErrorCodeOf(error);
    // Rust n'a rien écrit (refus ou erreur avant le renommage du registre) : l'intention redevient ce qu'elle était.
    await writeJson(deps.data.repos, FORGET_META.publish, previous === true ? true : null);
    if (code === 'consent-denied') {
      deps.logger.log('forget-cancelled', { device: deviceId });
      return { kind: 'cancelled' };
    }
    await recordFailure(deps, deviceId, 'declare', code);
    return { kind: 'failed', code };
  }
  await clearFailure(deps.data.repos, deviceId, ['declare']);
  deps.logger.log('forget-declared', { device: deviceId });
  return { kind: 'done' };
}

/** Publication de `forgotten` à forcer (déclaration confirmée depuis la dernière publication, ou arrêt avant elle). */
export async function forgetPublishPending(repos: Repositories): Promise<boolean> {
  return (await readJson<boolean>(repos, FORGET_META.publish)) === true;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ordre total et statut des appareils (critères 7, 9, 10, 16)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Auteurs oubliés (Y-10, seconde revue point 1) : leurs instantanés ne sont jamais proposés (arrivée, reprise, changement d'époque). */
export type ForgottenAuthors = Pick<ReadonlySet<DeviceId>, 'has'>;

export interface ForgetView {
  /** Appareils oubliés par la liste maître, et l'auteur de la déclaration retenue. */
  readonly order: ReadonlyMap<DeviceId, ForgetVerdict>;
  /** Liste maître rendue par Rust (publiée telle quelle). */
  readonly master: readonly ForgottenDevice[];
  /** Appareils oubliés terminés (plus aucun accusé publié sur eux, jamais relus). */
  readonly done: ReadonlySet<DeviceId>;
  /** Cet appareil est oublié, ou l'a été (`selfForgotten` du registre, §18 point 12) : il ne lit ni ne publie plus (phase `forgotten`). */
  readonly selfForgotten: boolean;
  /** Oublis annulés (§18 point 12), gardés jusqu'à un nouvel oubli. */
  readonly revived: readonly RevivedDevice[];
}

/**
 * Début de cycle : ordre total calculé sur la liste maître du scan (Rust, §18 point 3 ; `sync_meta` n'en garde qu'un cache), statut
 * `forgotten` posé pour chaque appareil oublié (autre que soi) ; débordement de la liste (§18 point 5) : échec visible tant qu'il dure.
 */
export async function evaluateForget(
  deps: SyncDeps,
  input: { readonly registry: ForgottenRegistryView; readonly rows: readonly SyncStateRow[]; readonly previousRows?: readonly SyncStateRow[] },
): Promise<ForgetView> {
  const repos = deps.data.repos;
  const master = input.registry.entries;
  const cached = await readJson<unknown>(repos, FORGET_META.declarations);
  // Cache seulement (jamais une source) ; rien écrit tant qu'il n'y a rien à garder.
  if (JSON.stringify(cached ?? []) !== JSON.stringify(master)) await writeJson(repos, FORGET_META.declarations, master);
  const order = forgetOrder(master);
  const status = new Map(input.rows.map((row) => [row.deviceId, row.status]));
  for (const [target, verdict] of order) {
    if (target === deps.deviceId || status.get(target) === 'forgotten') continue;
    await repos.sync.saveState(target, { status: 'forgotten' });
    deps.logger.log('forget-applied', { device: target, by: verdict.by });
  }
  // Oubli annulé (§18 point 12) : le verdict suit l'ordre total à chaque scan ; un appareil qui n'est plus oublié redevient actif, gardé
  // dans `forgetRevived` jusqu'à un nouvel oubli ; un terminé n'est jamais relu (horizon `blocked`).
  const done = new Set(input.registry.done);
  const revived = new Map(parseRevived(await readJson<unknown>(repos, FORGET_META.revived)).map((r) => [r.deviceId, r]));
  // Statuts d'avant le scan (`previousRows`) : l'acceptation des états a déjà pu remettre un appareil présent à `active`.
  const wasForgotten = new Set([...(input.previousRows ?? []), ...input.rows].filter((r) => !r.isSelf && r.status === 'forgotten').map((r) => r.deviceId as DeviceId));
  const current = new Map(input.rows.map((r) => [r.deviceId as DeviceId, r.status]));
  for (const id of wasForgotten) {
    if (order.has(id) || id === deps.deviceId) continue;
    if (current.get(id) === 'forgotten') await repos.sync.saveState(id, { status: 'active' });
    if (!revived.has(id)) deps.logger.log('forget-revived', { device: id });
    revived.set(id, { deviceId: id, done: done.has(id) });
  }
  for (const id of done) if (!order.has(id) && id !== deps.deviceId) revived.set(id, { deviceId: id, done: true });
  for (const id of [...revived.keys()]) if (order.has(id)) revived.delete(id);
  const revivedList = [...revived.values()].map((r) => ({ ...r, done: r.done || done.has(r.deviceId) })).sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
  const storedRevived = await readJson<unknown>(repos, FORGET_META.revived);
  if (JSON.stringify(storedRevived ?? []) !== JSON.stringify(revivedList)) await writeJson(repos, FORGET_META.revived, revivedList.length === 0 ? null : revivedList);
  if (input.registry.overflow) {
    const failure = parseForgetFailure(await readJson<unknown>(repos, FORGET_META.failure));
    if (failure?.step !== 'overflow') await recordFailure(deps, deps.deviceId, 'overflow', 'too-large');
  } else {
    await clearFailure(repos, deps.deviceId, ['overflow']);
  }
  return { order, master, done, selfForgotten: order.has(deps.deviceId) || input.registry.selfForgotten !== null, revived: revivedList };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Coupure (critère 8)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Position jusqu'à laquelle lire l'appareil oublié `target` : maximum des accusés de `target` publiés par les appareils actifs non
 * oubliés (son propre état compris) et de sa position locale ; null : rien à lire (aucun accusé, ou appareil terminé).
 */
export function readLimit(
  target: DeviceId,
  view: ForgetView,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  ownState: PublishedDeviceState | null,
  local: DeviceAck | null,
): DeviceAck | null {
  if (view.done.has(target)) return null;
  const live = [...accepted.values()].filter((s) => !view.order.has(s.deviceId));
  if (ownState) live.push(ownState);
  // Y-11 (remarques finales) : un accusé après la dernière époque publiée par sa cible ne désigne rien (même filtre que Rust).
  const ackers = withoutStaleAcks(live, publishedEpochs([...accepted.values(), ...(ownState ? [ownState] : [])]));
  const cut = cutoff(target, ackers);
  if (local === null) return cut;
  if (cut === null) return local;
  return compareAckPositions(local, cut) > 0 ? local : cut;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression des fichiers des appareils oubliés (critères 11 à 13, 15)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Appareils connus vus du moteur, sous la forme de `forgottenDeleteCheck` (mêmes règles que Rust) : dossiers du scan, appareils cités
 * dans les accusés des actifs non oubliés, états déjà acceptés, cibles de la liste maître ; `seen` : `seenDevices` (anti-rejeu du registre
 * rendu par le scan, ou cité par un actif), comme Rust.
 */
export function forgetKnownDevices(
  scan: FolderScan,
  view: ForgetView,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  self: DeviceId,
  ownPublished: PublishedDeviceState | null,
): ForgetKnownDevice[] {
  // Même définition que Rust (seconde revue, point 4) : anti-rejeu du registre (`scan.forgotten.accepted`) ou cité par un actif.
  const seenSet = seenDevices(scan.forgotten.accepted, [...accepted.values(), ...(ownPublished ? [ownPublished] : [])], view.master);
  const known = new Map<DeviceId, ForgetKnownDevice>();
  const seen = (id: DeviceId): boolean => id === self || seenSet.has(id);
  for (const device of scan.devices) {
    if (device.deviceId === self) continue;
    const state = accepted.get(device.deviceId) ?? null;
    // Un état `ok` au scan mais refusé par l'anti-rejeu local (rejeu) n'est pas authentifié ici.
    const status = device.stateStatus === 'ok' && state === null ? 'rollback' : device.stateStatus;
    known.set(device.deviceId, { deviceId: device.deviceId, status, state: status === 'ok' ? state : null, seen: seen(device.deviceId) });
  }
  known.set(self, ownPublished ? { deviceId: self, status: 'ok', state: ownPublished, seen: true } : { deviceId: self, status: 'missing', state: null, seen: true });
  for (const id of [...seenSet, ...view.master.map((e) => e.deviceId)]) {
    if (!known.has(id)) known.set(id, { deviceId: id, status: 'missing', state: null, seen: seen(id) });
  }
  return [...known.values()];
}

/**
 * Fin de cycle : pour chaque appareil oublié pas encore terminé (`done` de Rust), conditions vérifiées (mêmes que Rust) ; réunies :
 * `sync_forgotten_delete` (sans boîte), y compris quand son dossier a déjà disparu (Rust l'inscrit alors dans `done`) ; sinon « en
 * attente de {appareil} ». L'état est gardé dans `sync_meta` ; un échec de suppression est effacé quand la cible est terminée ou n'a
 * plus de dossier (revue Y-10, point 4).
 */
export async function runForgetDeletions(
  deps: SyncDeps,
  input: {
    readonly view: ForgetView;
    readonly scan: FolderScan;
    readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>;
    readonly ownPublished: PublishedDeviceState | null;
    /** Condition (h) : fin de l'instantané annoncé par son état publié (lue par `tail`, comme Rust). */
    readonly ownSnapshot: SnapshotEndRead;
  },
): Promise<void> {
  const repos = deps.data.repos;
  const stored = new Map(parseForgetDeletions(await readJson<unknown>(repos, FORGET_META.deletions)).map((d) => [d.deviceId, d]));
  const next = new Map(stored);
  const known = forgetKnownDevices(input.scan, input.view, input.accepted, deps.deviceId, input.ownPublished);
  for (const target of input.view.order.keys()) {
    if (target === deps.deviceId) continue;
    const listing = input.scan.devices.find((d) => d.deviceId === target);
    const strictFiles = listing !== undefined && (listing.stateStatus !== 'missing' || listing.epochs.some((e) => e.segments.length + e.snapshots.length > 0));
    if (input.view.done.has(target) && !strictFiles) {
      // Terminé chez Rust : plus rien à faire ; un dossier qui ne garde que des noms étrangers est signalé.
      next.set(target, { deviceId: target, state: listing ? 'strays' : 'done', waitingFor: null });
      await clearFailure(repos, target, ['delete']);
      continue;
    }
    if (!listing) await clearFailure(repos, target, ['delete']);
    const check = forgottenDeleteCheck(target, deps.deviceId, input.view.master, [...input.view.done], known, input.ownSnapshot);
    if (check.kind === 'waiting' || check.kind === 'refused') {
      // Dossier déjà disparu (supprimé par un autre appareil actif) : « finalisation en attente de {appareil} » jusqu'à ce que Rust
      // l'inscrive dans `done` (seconde revue, point 5 : jamais effacée avant).
      const waitingFor = check.kind === 'waiting' && check.device !== deps.deviceId ? check.device : null;
      next.set(target, { deviceId: target, state: listing ? 'waiting' : 'finalizing', waitingFor });
      continue;
    }
    const previous = stored.get(target);
    deps.deadline?.check('forgotten-delete');
    try {
      const result = await deps.platform.forget.deleteFiles(target);
      deps.logger.log('forgotten-delete', { device: target, deleted: result.deleted, complete: result.complete });
      await clearFailure(repos, target, ['delete']);
      next.set(target, { deviceId: target, state: result.complete ? 'done' : 'deleting', waitingFor: null });
    } catch (error) {
      await recordFailure(deps, target, 'delete', syncErrorCodeOf(error));
      next.set(target, { deviceId: target, state: previous?.state === 'deleting' ? 'deleting' : 'waiting', waitingFor: null });
    }
  }
  const text = (m: ReadonlyMap<DeviceId, ForgetDeletionStatus>): string => JSON.stringify([...m.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)));
  if (text(next) !== text(stored)) await writeJson(repos, FORGET_META.deletions, JSON.parse(text(next)) as unknown);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Associer de nouveau (critère 17, D2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** hlc de `from` réécrit au nom de `to` : même instant, même compteur (l'ordre avec les autres appareils ne change pas). */
const restamp = (hlc: Hlc, to: DeviceId): Hlc => `${hlc.slice(0, 21)}${to}` as Hlc;

/** Méta du moteur propres à l'identité publiée, remises à zéro pour la nouvelle (les curseurs repartent de l'instantané). */
const IDENTITY_META = [META.epoch, META.stateSeq, META.head, META.inflight, META.lastState, META.snapshot, META.segments, META.epochSwitch, META.epochCarry, META.resume, 'join', FORGET_META.publish, FORGET_META.deletions] as const;

/**
 * « Associer de nouveau » (D2) sur un appareil oublié qui a encore la clé : rien n'est effacé localement.
 * 1. Coupure de cet appareil vue des autres (maximum de leurs accusés) : ses écritures au-delà n'ont été lues par personne.
 * 2. Une transaction gardée : ces écritures (champs dont le hlc est le sien et au-delà de la coupure) sont **rattachées à la nouvelle
 *    identité** (même instant, même compteur : la fusion par hlc ne change pas) et remises dans la file ; nouvel identifiant
 *    (`device.id`), métas de publication remises à zéro, intention `rejoin` mémorisée.
 * 3. Le dossier est délié, clé gardée (`sync_folder_forget`) ; un échec reste mémorisé (`rejoin`) et est repris au cycle suivant.
 * L'appelant relance l'app : la nouvelle identité est liée au dossier choisi de nouveau et rejoint par la fusion de l'instantané.
 */
export async function prepareRejoin(deps: SyncDeps, newId: DeviceId): Promise<RejoinOutcome> {
  const repos = deps.data.repos;
  const self = deps.deviceId;
  // Déjà fait par cette instance (nouvelle identité posée, app pas encore relancée) : rien n'est refait, seule la délie peut rester.
  const storedId = await repos.settings.get('device.id');
  if (storedId !== null && storedId !== self) return finishRejoin(deps);
  try {
    const rows = await repos.sync.getStates();
    const forgotten = new Set(rows.filter((r) => r.status === 'forgotten').map((r) => r.deviceId));
    const ackers = rows
      .filter((r) => !r.isSelf && !forgotten.has(r.deviceId))
      // Accusés illisibles : `state-unreadable`, « Associer de nouveau » en échec visible (jamais une coupure tirée d'accusés perdus).
      .map((r) => ({ deviceId: r.deviceId as DeviceId, acks: parseStoredAcks(r.lastAcks, 'sync_state.last_acks', deps.logger) }));
    const cut = cutoff(self, ackers)?.hlc ?? null;
    let moved = 0;
    await guarded(deps.data, async (tx) => {
      for (const t of SYNC_TABLES) {
        let after: string | null = null;
        for (;;) {
          const page = await tx.sync.exportRows(t, after, PAGE_ROWS);
          if (page.length === 0) break;
          after = (page.at(-1) as { id: string }).id;
          for (const row of page) {
            const fallback = row.clocks.get('*') ?? { hlc: row.hlc, base: null };
            const clocks = t.columns.map((col) => ({ field: col.name, ...(row.clocks.get(col.name) ?? fallback) }));
            const mine = (hlc: Hlc): boolean => hlcDevice(hlc) === self && (cut === null || hlc > cut);
            const changed = clocks.filter((c) => mine(c.hlc));
            if (changed.length === 0) continue;
            await tx.sync.replaceClocks(t, row.id, clocks.map((c) => (mine(c.hlc) ? { ...c, hlc: restamp(c.hlc, newId) } : c)));
            if (mine(row.hlc)) await tx.sync.updateRow(t, row.id, new Map(), { hlc: restamp(row.hlc, newId), updatedAt: row.updatedAt, deviceId: newId });
            await tx.sync.addOutbox(changed.map((c) => ({ table: t.name, rowId: row.id, field: c.field })));
            moved += 1;
          }
          if (page.length < PAGE_ROWS) break;
        }
      }
      for (const key of IDENTITY_META) await writeJson(tx, key, null);
      // L'ancienne identité devient un appareil oublié comme les autres (ligne « Oublié » d'APPAREILS).
      await tx.sync.saveState(self, { isSelf: false, status: 'forgotten' });
      await tx.settings.set('device.id', newId);
      await writeJson(tx, FORGET_META.rejoin, { from: self, to: newId });
    });
    deps.logger.log('forget-rejoin-prepared', { from: self, to: newId, rows: moved });
  } catch (error) {
    const code = syncErrorCodeOf(error);
    await recordFailure(deps, self, 'rejoin', code).catch(() => undefined);
    return { kind: 'failed', code };
  }
  return finishRejoin(deps);
}

/** Étape 3 de « Associer de nouveau » (reprise comprise) : dossier délié, clé gardée ; intention effacée à la réussite. */
export async function finishRejoin(deps: SyncDeps): Promise<RejoinOutcome> {
  const repos = deps.data.repos;
  const pending = await readJson<{ from: DeviceId; to: DeviceId }>(repos, FORGET_META.rejoin);
  if (pending === null) return { kind: 'restart' };
  try {
    await deps.platform.folder.forget({ eraseKey: false });
  } catch (error) {
    const code = syncErrorCodeOf(error);
    await recordFailure(deps, pending.from, 'rejoin', code);
    return { kind: 'failed', code };
  }
  await repos.sync.setMeta(FORGET_META.rejoin, null);
  await clearFailure(repos, pending.from, ['rejoin', 'declare', 'delete']);
  deps.logger.log('forget-rejoin-unbound', { from: pending.from, to: pending.to });
  return { kind: 'restart' };
}

/** Une reprise de « Associer de nouveau » est-elle en attente (dossier pas encore délié) ? */
export async function rejoinPending(repos: Repositories): Promise<boolean> {
  return (await readJson<unknown>(repos, FORGET_META.rejoin)) !== null;
}

