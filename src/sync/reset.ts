import type { Repositories, SyncStateRow } from '../db/repositories';
import { resetPrecondition, resetWinner, type ResetCandidate, type ResetLagReason, type ResetPreconditionDevice } from '../domain/sync/epoch';
import { DEVICE_EXPIRY_MS, isSyncDeviceId, isSyncErrorCode, SYNC_FORMAT_MAJOR, type DeviceAck, type EpochId, type PublishedDeviceState } from '../domain/sync/format';
import { hlcMs } from '../domain/sync/parse';
import { cutoff, seenDevices } from '../domain/sync/retention';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import {
  syncErrorCodeOf,
  type FolderScan,
  type ResetFailure,
  type ResetStep,
  type ResetView,
  type SyncErrorCode,
  type SyncResetStatus,
} from '../platform/sync/types';
import type { SyncDeps } from './deps';
import type { ForgetView } from './forget';
import { META, readJson, writeJson } from './meta';
import { snapshotPages } from './snapshot';

/**
 * Réinitialisation de la synchronisation avec une nouvelle clé (Y-11 ; ADR 0011 sections 9.1, 14.3 et 18 point 2) : partie moteur.
 *
 * - **Rust est maître** de la clé (`K2` sous `.next`, jamais dans la WebView), de l'annonce (`reset` publié sous l'ancienne clé), de la perte
 *   (constatée au scan) et de la bascule (au scan, étapes mémorisées, reprise au démarrage). Le moteur suit la vue rendue par le scan
 *   (`FolderScan.reset`) et la clé du coffre (`sync_key_status.nextKid`).
 * - **Appareil qui réinitialise** : précondition (« Synchronisez d'abord »), annonce publiée au cycle suivant, puis ouverture de l'époque
 *   `n+1` (instantané complet, `covers` = têtes lues et position sur chaque oublié retenu), liste des appareils pas encore réassociés,
 *   rappel après 30 jours (jamais d'oubli d'office).
 * - **Autres appareils** : suspension (file gardée, rien d'écrit) seulement sur une annonce **authentique** (état déchiffré avec la clé
 *   locale, accepté par l'anti-rejeu, d'un appareil déjà connu avec cette clé) ; phase `reset-required` jusqu'à la réassociation.
 * - **Perdant d'une réinitialisation simultanée** : republie une fois son état sous l'ancienne clé avec `reset: null`, puis `reset-required`.
 * - **Aucun échec silencieux** (exigence d'Ali) : l'état et tout échec (code, heure, étape ; jamais de contenu ni de clé) sont gardés dans
 *   `sync_meta.resetState`, lus par `status().reset`, effacés seulement à la fin de la bascule (ou à la fermeture de l'écran « terminée »).
 *
 * Journal technique : `reset-*` (étapes, codes, identifiants d'appareil et d'époque).
 */

/** Clé de `sync_meta` (table locale, jamais publiée). */
export const RESET_META = 'resetState';

/** Rappel des appareils pas encore réassociés (§14.3 « Pas d'oubli d'office », D5) : bandeau seulement, jamais d'action. */
export const RESET_REMINDER_MS = 30 * 86_400_000;

/** État gardé dans `sync_meta.resetState`. */
export interface ResetState {
  readonly role: 'initiator' | 'joined' | 'required';
  readonly step: ResetStep;
  /** `kid` de la nouvelle clé (jamais la clé). */
  readonly kid: string | null;
  readonly epoch: EpochId | null;
  /** Appareil de l'annonce suivie (gagnante, ou celle de cette réinitialisation). */
  readonly by: DeviceId | null;
  readonly superseded: boolean;
  readonly startedAt: IsoDateTime;
  /** Début de l'attente des appareils (rappel des 30 jours). */
  readonly waitingSince: IsoDateTime | null;
  readonly waiting: readonly DeviceId[];
  /** Perdant : état sous l'ancienne clé republié avec `reset: null`. */
  readonly republished: boolean;
  /** Bascule interrompue reprise au démarrage (dit par l'écran). */
  readonly resumed: boolean;
  readonly failure: ResetFailure | null;
}

const STEPS: readonly ResetStep[] = ['start', 'announced', 'snapshot', 'waiting-devices', 'switching', 'superseded', 'required', 'joined', 'done'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is IsoDateTime => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseFailure(value: unknown): ResetFailure | null {
  if (!isRecord(value) || !isSyncErrorCode(value['code']) || !isIso(value['at']) || !(STEPS.includes(value['step'] as ResetStep) || value['step'] === 'start')) return null;
  return { code: value['code'], at: value['at'], step: value['step'] as ResetFailure['step'] };
}

/** Lecture défensive : une valeur mal formée (autre version) est ignorée, jamais une panne. */
export function parseResetState(value: unknown): ResetState | null {
  if (!isRecord(value)) return null;
  const role = value['role'];
  const step = value['step'];
  if ((role !== 'initiator' && role !== 'joined' && role !== 'required') || !STEPS.includes(step as ResetStep) || !isIso(value['startedAt'])) return null;
  const waiting = Array.isArray(value['waiting']) ? value['waiting'].filter(isSyncDeviceId) : [];
  return {
    role,
    step: step as ResetStep,
    kid: typeof value['kid'] === 'string' && /^[0-9a-f]{16}$/.test(value['kid']) ? value['kid'] : null,
    epoch: typeof value['epoch'] === 'string' ? (value['epoch'] as EpochId) : null,
    by: isSyncDeviceId(value['by']) ? value['by'] : null,
    superseded: value['superseded'] === true,
    startedAt: value['startedAt'],
    waitingSince: isIso(value['waitingSince']) ? value['waitingSince'] : null,
    waiting,
    republished: value['republished'] === true,
    resumed: value['resumed'] === true,
    failure: parseFailure(value['failure']),
  };
}

export async function readResetState(repos: Repositories): Promise<ResetState | null> {
  return parseResetState(await readJson<unknown>(repos, RESET_META));
}

async function writeResetState(deps: SyncDeps, state: ResetState | null): Promise<void> {
  await writeJson(deps.data.repos, RESET_META, state);
}

const iso = (ms: number): IsoDateTime => new Date(ms).toISOString() as IsoDateTime;

/** État affiché (`SyncStatus.reset`) : rappel des 30 jours calculé à l'heure donnée (horloge injectée). */
export function resetStatusOf(state: ResetState | null, nowMs: number): SyncResetStatus | null {
  if (!state) return null;
  const reminder = state.role === 'initiator' && state.step === 'waiting-devices' && state.waitingSince !== null && nowMs - Date.parse(state.waitingSince) >= RESET_REMINDER_MS;
  return {
    role: state.role,
    step: state.step,
    by: state.by,
    superseded: state.superseded,
    waiting: state.waiting,
    reminder,
    startedAt: state.startedAt,
    resumed: state.resumed,
    failure: state.failure,
  };
}

export async function readResetStatus(repos: Repositories, nowMs: number): Promise<SyncResetStatus | null> {
  return resetStatusOf(await readResetState(repos), nowMs);
}

/**
 * Échec gardé (exigence d'Ali) : écrit dans `resetState`, jamais seulement journalisé. Sans état (échec du lancement), un état `start`
 * est créé pour le montrer jusqu'à un nouvel essai réussi ou abandonné.
 */
export async function recordResetFailure(deps: SyncDeps, step: ResetFailure['step'], code: SyncErrorCode): Promise<void> {
  const now = iso(deps.clock.nowMs());
  const current = await readResetState(deps.data.repos);
  const base: ResetState = current ?? {
    role: 'initiator',
    step: 'start',
    kid: null,
    epoch: null,
    by: deps.deviceId,
    superseded: false,
    startedAt: now,
    waitingSince: null,
    waiting: [],
    republished: false,
    resumed: false,
    failure: null,
  };
  await writeResetState(deps, { ...base, failure: { code, at: now, step } });
  deps.logger.log('reset-failed', { step, code });
}

/** Efface l'état « terminée » ou un échec de lancement (choix de l'utilisateur) ; jamais une transition en cours. */
export async function dismissResetState(deps: SyncDeps): Promise<void> {
  const current = await readResetState(deps.data.repos);
  if (current && (current.step === 'done' || current.step === 'start')) await writeResetState(deps, null);
}

/** Lancement accepté par Rust (`K2` créée) : l'appareil qui réinitialise publie l'annonce au cycle suivant. */
export async function beginReset(deps: SyncDeps, kid: string): Promise<void> {
  const now = iso(deps.clock.nowMs());
  await writeResetState(deps, {
    role: 'initiator',
    step: 'announced',
    kid,
    epoch: null,
    by: deps.deviceId,
    superseded: false,
    startedAt: now,
    waitingSince: null,
    waiting: [],
    republished: false,
    resumed: false,
    failure: null,
  });
  deps.logger.log('reset-started', { kid });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Décision de chaque cycle
// ---------------------------------------------------------------------------------------------------------------------------------

export type ResetDirective =
  /** Rien (ou réinitialisation terminée) : cycle ordinaire. */
  | { readonly kind: 'none' }
  /** Cet appareil réinitialise : annonce sous l'ancienne clé, ouverture de l'époque visée, attente des appareils. */
  | { readonly kind: 'initiator'; readonly view: ResetView }
  /** Cet appareil est réassocié : il rejoint l'époque visée par fusion et attend la bascule de l'auteur. */
  | { readonly kid: string; readonly kind: 'joined'; readonly view: ResetView }
  /** Cet appareil doit être associé de nouveau (annonce authentique, ou perte) : publication suspendue, file gardée. */
  | { readonly kind: 'required'; readonly republish: boolean };

export interface ResetInput {
  readonly scan: FolderScan;
  /** Lignes de `sync_state` d'avant ce scan (appareil « déjà connu avec la clé locale »). */
  readonly known: ReadonlyMap<string, SyncStateRow>;
  /** États acceptés par l'anti-rejeu dans ce cycle. */
  readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>;
  readonly forget: ForgetView;
  readonly key: { readonly kid: string | null; readonly nextKid?: string | null };
}

/** Annonces **authentiques** (critère 8) : état déchiffré avec la clé locale, accepté, d'un appareil déjà connu avec cette clé. */
export function authenticAnnouncements(input: ResetInput, self: DeviceId): ResetCandidate[] {
  const out: ResetCandidate[] = [];
  for (const device of input.scan.devices) {
    if (device.deviceId === self || device.stateStatus !== 'ok' || !device.state?.reset) continue;
    if (input.key.kid === null || device.kid !== input.key.kid) continue;
    const state = input.accepted.get(device.deviceId);
    if (!state || state.stateSeq !== device.state.stateSeq) continue;
    const row = input.known.get(device.deviceId);
    if (!row || row.kid !== input.key.kid || row.stateSeq <= 0) continue;
    out.push({ by: device.deviceId, stateEpoch: device.state.epoch, notice: device.state.reset });
  }
  return out;
}

function stepOf(view: ResetView): ResetStep {
  if (view.role === 'joined') return view.switching ? 'switching' : 'joined';
  if (view.switching) return 'switching';
  if (view.stage === 'created') return 'announced';
  if (view.stage === 'announced') return 'snapshot';
  return 'waiting-devices';
}

/**
 * Début de cycle (après le scan et l'ordre des oublis) : suit la vue de Rust, constate la fin, la perte, la suspension, et garde l'état.
 * Une écriture de `resetState` en échec remonte (le cycle échoue de façon visible).
 */
export async function evaluateReset(deps: SyncDeps, input: ResetInput): Promise<ResetDirective> {
  const self = deps.deviceId;
  const stored = await readResetState(deps.data.repos);
  const now = iso(deps.clock.nowMs());
  const view = input.scan.reset ?? null;
  const base = (role: ResetState['role'], step: ResetStep): ResetState => ({
    role,
    step,
    kid: view?.kid ?? stored?.kid ?? null,
    epoch: view?.epoch ?? stored?.epoch ?? null,
    by: view?.by ?? stored?.by ?? null,
    superseded: false,
    startedAt: stored && stored.step !== 'done' ? stored.startedAt : now,
    waitingSince: stored?.waitingSince ?? null,
    waiting: [],
    republished: stored?.republished ?? false,
    resumed: stored?.resumed ?? false,
    // Un échec reste affiché jusqu'à la réussite de la même étape (sinon il est effacé quand l'étape avance).
    failure: stored?.failure && stored.step === step ? stored.failure : null,
  });
  const save = async (next: ResetState): Promise<void> => {
    if (JSON.stringify(next) !== JSON.stringify(stored)) await writeResetState(deps, next);
  };

  if (view?.switched) {
    await save({ ...base(stored?.role === 'joined' || view.role === 'joined' ? 'joined' : 'initiator', 'done'), resumed: view.resumed || (stored?.resumed ?? false), failure: null, waiting: [] });
    deps.logger.log('reset-switched', { resumed: view.resumed });
    return { kind: 'none' };
  }
  if (view?.superseded) {
    await save({ ...base(view.role, 'superseded'), by: view.superseded.by, epoch: view.superseded.epoch, superseded: true });
    return { kind: 'required', republish: view.role === 'initiator' && stored?.republished !== true };
  }
  if (view) {
    const step = stepOf(view);
    const waitingSince = step === 'waiting-devices' ? (stored?.waitingSince ?? now) : null;
    // Reprise d'une bascule interrompue : dite par l'écran (critère 17).
    const resumed = (stored?.resumed ?? false) || view.resumed;
    await save({ ...base(view.role, step), waiting: view.waiting, waitingSince, resumed });
    return view.role === 'initiator' ? { kind: 'initiator', view } : { kind: 'joined', kid: view.kid, view };
  }
  // Bascule faite par un scan dont ce cycle n'a pas vu le résultat (arrêt juste après) : la clé locale est devenue la nouvelle clé.
  if (stored && (stored.role === 'initiator' || stored.role === 'joined') && !['done', 'start', 'superseded'].includes(stored.step) && stored.kid !== null && input.key.kid === stored.kid && !input.key.nextKid) {
    await save({ ...stored, step: 'done', failure: null, waiting: [] });
    deps.logger.log('reset-switched', { resumed: true });
    return { kind: 'none' };
  }
  // Autres appareils : annonce authentique d'une réinitialisation lancée ailleurs.
  const forgotten = new Set(input.forget.order.keys());
  const winner = resetWinner(authenticAnnouncements(input, self), forgotten);
  if (winner && input.key.nextKid !== winner.notice.kid) {
    if (stored?.role !== 'required' || stored.by !== winner.by || stored.epoch !== winner.notice.epoch) deps.logger.log('reset-required', { by: winner.by });
    await save({ ...base('required', 'required'), by: winner.by, epoch: winner.notice.epoch, kid: null, superseded: stored?.superseded ?? false });
    return { kind: 'required', republish: false };
  }
  if (stored?.role === 'required' || stored?.step === 'superseded') {
    // Gardé jusqu'à la réassociation, sauf retrait constaté : l'auteur suivi est lu avec la clé locale, sans annonce (ou une autre).
    const author = stored.by ? input.scan.devices.find((d) => d.deviceId === stored.by) : undefined;
    const withdrawn = author?.stateStatus === 'ok' && author.kid === input.key.kid && (!author.state?.reset || author.state.reset.epoch !== stored.epoch) && stored.role === 'required';
    if (!withdrawn) return { kind: 'required', republish: false };
    await writeResetState(deps, null);
    deps.logger.log('reset-required-cleared', { by: stored.by });
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Annonce à publier sous l'ancienne clé par l'appareil qui réinitialise (tant qu'il n'a pas ouvert l'époque visée). */
export function noticeToPublish(directive: ResetDirective, epoch: EpochId): PublishedDeviceState['reset'] {
  if (directive.kind !== 'initiator') return null;
  const view = directive.view;
  return view.notice && view.epoch !== epoch && view.stage !== 'opened' ? view.notice : null;
}

/** Réinitialisation en cours sur cet appareil (suppressions de Y-10 et anciennes époques suspendues, comme chez Rust). */
export function resetActive(directive: ResetDirective): boolean {
  return directive.kind !== 'none';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Appareil qui réinitialise : précondition, ouverture de l'époque n+1
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Précondition (critère 3), mêmes règles que Rust (`reset_precondition`) sur ce que le scan présente : chaque appareil actif lu jusqu'à sa
 * tête (accusés de son propre état publié), chaque oublié retenu lu jusqu'à sa coupure. Premier appareil en retard, ou null.
 */
export function resetLagging(
  deps: SyncDeps,
  input: { readonly scan: FolderScan; readonly forget: ForgetView; readonly accepted: ReadonlyMap<DeviceId, PublishedDeviceState>; readonly own: PublishedDeviceState | null },
): { readonly device: DeviceId | null; readonly reason: ResetLagReason | 'own' } | null {
  const self = deps.deviceId;
  if (!input.own) return { device: null, reason: 'own' };
  const order = input.forget.order;
  const ok = input.scan.devices.filter((d) => d.stateStatus === 'ok' && d.state).map((d) => d.state as PublishedDeviceState);
  const seen = seenDevices(input.scan.forgotten.accepted, ok, input.forget.master);
  const authors = new Set(input.forget.master.map((e) => e.at.slice(21) as DeviceId));
  const now = deps.clock.nowMs();
  const ids = new Set<DeviceId>([...input.scan.devices.map((d) => d.deviceId), ...seen, ...input.forget.master.map((e) => e.deviceId)]);
  const actives: ResetPreconditionDevice[] = [...ids]
    .filter((id) => id !== self && !order.has(id))
    .map((id) => {
      const device = input.scan.devices.find((d) => d.deviceId === id);
      const status = device?.stateStatus ?? 'missing';
      const state = status === 'ok' ? (device?.state ?? null) : null;
      return { deviceId: id, status, head: state?.head ?? null, expired: state !== null && hlcMs(state.lastSyncHlc) + DEVICE_EXPIRY_MS < now, phantom: status !== 'ok' && !seen.has(id) && !authors.has(id) };
    });
  const live = [...ok.filter((s) => !order.has(s.deviceId) && s.deviceId !== self), input.own];
  const cuts = [...order.keys()].map((target) => ({ deviceId: target, cutoff: cutoff(target, live) }));
  return resetPrecondition(actives, cuts, input.own.acks);
}

/**
 * Ouverture de l'époque visée (§14.3 étape 4) juste après la publication de l'annonce : instantané complet de la base (`covers` = accusés
 * de l'époque `n`, têtes lues et position sur chaque oublié retenu, plus sa propre tête), file vidée jusqu'au numéro pris avant
 * l'instantané (l'instantané contient tout), époque locale déplacée, puis état sous la nouvelle clé (`state.next.ctx`, Rust choisit la
 * clé et le fichier d'après l'époque). Chaque échec est gardé (étape `snapshot`).
 */
export async function openResetEpoch(
  deps: SyncDeps,
  input: {
    readonly target: EpochId;
    readonly covers: Map<DeviceId, DeviceAck>;
    readonly listedSnapshots: readonly number[];
    readonly writeState: (state: PublishedDeviceState) => Promise<boolean>;
    readonly buildState: (epoch: EpochId, head: DeviceAck, snapshot: { seq: number; endHlc: Hlc }) => PublishedDeviceState;
  },
): Promise<boolean> {
  const { data, platform } = deps;
  const target = input.target;
  try {
    const maxSeq = await data.repos.sync.maxOutboxSeq();
    const seq = Math.max(0, ...input.listedSnapshots) + 1;
    const endHlc = deps.hlc.now();
    await platform.writeSnapshot({ epoch: target, seq, sv: deps.sv, records: snapshotPages(data.repos, target, input.covers, deps.sv) });
    const head: DeviceAck = { epoch: target, segment: 0, record: 0, hlc: null, stateSeq: 0 };
    await data.transaction(async (tx) => {
      await tx.sync.clearOutbox(maxSeq);
      await writeJson(tx, META.epoch, target);
      await writeJson(tx, META.head, head);
      await writeJson(tx, META.snapshot, { epoch: target, seq, endHlc, coveredSegment: 0, covers: Object.fromEntries(input.covers) });
      await writeJson(tx, META.segments, null);
      await writeJson(tx, META.resume, null);
    });
    deps.logger.log('reset-epoch-opened', { epoch: target, seq });
    const written = await input.writeState(input.buildState(target, head, { seq, endHlc }));
    if (!written) {
      await recordResetFailure(deps, 'snapshot', 'state-mismatch');
      return false;
    }
    // Époque visée ouverte : attente des appareils (l'échec de l'ouverture, s'il y en avait un, est résolu).
    const current = await readResetState(data.repos);
    if (current) await writeResetState(deps, { ...current, step: 'waiting-devices', failure: null, waitingSince: current.waitingSince ?? iso(deps.clock.nowMs()) });
    return true;
  } catch (error) {
    await recordResetFailure(deps, 'snapshot', syncErrorCodeOf(error));
    throw error;
  }
}

/**
 * Perdant d'une réinitialisation simultanée (§18 point 2) : son état sous l'ancienne clé est republié **une fois** avec `reset: null`
 * (Rust a ramené `own.json` à l'époque `n`) ; l'époque locale revient à celle de cet état. Échec gardé (étape `superseded`).
 */
export async function republishWithoutNotice(deps: SyncDeps, own: PublishedDeviceState | null, forgotten: PublishedDeviceState['forgotten']): Promise<void> {
  if (!own) return;
  const repos = deps.data.repos;
  try {
    const seq = Math.max((await readJson<number>(repos, META.stateSeq)) ?? 0, own.stateSeq) + 1;
    const state: PublishedDeviceState = {
      ...own,
      sm: SYNC_FORMAT_MAJOR,
      sv: deps.sv,
      stateSeq: seq,
      head: { ...own.head, stateSeq: seq },
      lastSyncHlc: deps.hlc.now(),
      forgotten: [...forgotten],
      reset: null,
    };
    await deps.platform.writeState({ sv: deps.sv, state });
    const current = await readResetState(repos);
    await deps.data.transaction(async (tx) => {
      await writeJson(tx, META.stateSeq, seq);
      await writeJson(tx, META.epoch, own.epoch);
      await writeJson(tx, META.head, { ...own.head, stateSeq: 0 });
      await writeJson(tx, META.snapshot, own.snapshot ? { epoch: own.epoch, seq: own.snapshot.seq, endHlc: own.snapshot.endHlc } : null);
      await writeJson(tx, META.lastState, null);
      if (current) await writeJson(tx, RESET_META, { ...current, republished: true, failure: null });
    });
    deps.logger.log('reset-withdrawn', { epoch: own.epoch });
  } catch (error) {
    await recordResetFailure(deps, 'superseded', syncErrorCodeOf(error));
    throw error;
  }
}
