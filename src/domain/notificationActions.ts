import { compareCodeUnits } from './compareCodeUnits';
import { localDateTimeAt } from './notificationInstant';
import { isLocalDate, isLocalDateTime, type LocalDate, type LocalDateTime } from './types';

/**
 * Actions de notification « Fait » et « +15 min » (N-03, ADR 0012 avenant N-03) : règles pures de la file locale durable
 * `notifications.actionQueue` (réglage LOCAL, jamais synchronisé), clés d'idempotence, résolution de la cible et heure d'une répétition.
 * Aucune horloge ni fuseau implicites : tout est passé en argument.
 */

export type NotificationActionId = 'done' | 'snooze15';
export const NOTIFICATION_ACTION_IDS: readonly NotificationActionId[] = ['done', 'snooze15'];

/** Plafonds de la file (avenant N3.4). */
export const ACTION_QUEUE_MAX_ENTRIES = 100;
export const ACTION_QUEUE_MAX_APPLIED = 200;
export const ACTION_QUEUE_MAX_SNOOZES = 100;
export const ACTION_APPLIED_TTL_MS = 30 * 86_400_000;
/** Durée de la répétition « +15 min ». */
export const SNOOZE_DELAY_MS = 15 * 60_000;
/** Repli quand l'échéance de la répétition est déjà passée à l'application : jamais une action perdue en silence. */
export const SNOOZE_LATE_FALLBACK_MS = 2 * 60_000;

/** Action reçue, telle que la rend le fichier natif (une ligne). */
export interface RawNotificationAction {
  /** Identifiant numérique du plugin (−1 si illisible). */
  readonly numericId: number;
  readonly actionId: NotificationActionId;
  /** Instant de la réponse de l'utilisateur (ms UTC). */
  readonly receivedAtMs: number;
  /** Identifiant stable (`extra.sid`) ; null si la notification n'en portait pas. */
  readonly sid: string | null;
  /** Instant planifié de la notification livrée (`extra.at`, ms UTC) ; null si absent. */
  readonly deliveredAt: number | null;
}

export type ActionError = 'target-not-found' | 'apply-failed';

export interface ActionQueueEntry {
  readonly key: string;
  readonly sid: string | null;
  readonly numericId: number;
  readonly action: NotificationActionId;
  readonly receivedAt: number;
  readonly tries: number;
  readonly lastError: ActionError | null;
}

export interface SnoozeEntry {
  /** `snooze:{identifiant d'origine}`. */
  readonly id: string;
  readonly originId: string;
  readonly fireAt: LocalDateTime;
}

export interface NotificationActionQueueV1 {
  readonly v: 1;
  readonly entries: readonly ActionQueueEntry[];
  readonly applied: readonly { readonly key: string; readonly at: number }[];
  readonly snoozes: readonly SnoozeEntry[];
  /** Entrées écartées faute de place (visible jusqu'à « Ignorer »). */
  readonly dropped: number;
  /** Lignes illisibles ou écritures impossibles côté natif (visible jusqu'à « Ignorer »). */
  readonly lost: number;
}

export const EMPTY_ACTION_QUEUE: NotificationActionQueueV1 = { v: 1, entries: [], applied: [], snoozes: [], dropped: 0, lost: 0 };

export type ActionQueueRead = { readonly state: 'valid'; readonly queue: NotificationActionQueueV1 } | { readonly state: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isAction = (value: unknown): value is NotificationActionId => value === 'done' || value === 'snooze15';

/** Analyse stricte ; `null` ou `undefined` (jamais écrit) = file vide valide, tout champ faux = illisible. */
export function parseActionQueue(raw: unknown): ActionQueueRead {
  if (raw === null || raw === undefined) return { state: 'valid', queue: EMPTY_ACTION_QUEUE };
  if (!isRecord(raw) || raw['v'] !== 1) return { state: 'unreadable' };
  const { entries, applied, snoozes, dropped, lost } = raw;
  if (!Array.isArray(entries) || !Array.isArray(applied) || !Array.isArray(snoozes) || !isCount(dropped) || !isCount(lost)) return { state: 'unreadable' };
  const outEntries: ActionQueueEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return { state: 'unreadable' };
    const { key, sid, numericId, action, receivedAt, tries, lastError } = entry;
    if (typeof key !== 'string' || key === '' || (sid !== null && typeof sid !== 'string') || typeof numericId !== 'number' || !Number.isInteger(numericId)) return { state: 'unreadable' };
    if (!isAction(action) || !isMs(receivedAt) || !isCount(tries) || (lastError !== null && lastError !== 'target-not-found' && lastError !== 'apply-failed')) return { state: 'unreadable' };
    outEntries.push({ key, sid, numericId, action, receivedAt, tries, lastError });
  }
  const outApplied: { key: string; at: number }[] = [];
  for (const item of applied) {
    if (!isRecord(item) || typeof item['key'] !== 'string' || !isMs(item['at'])) return { state: 'unreadable' };
    outApplied.push({ key: item['key'], at: item['at'] });
  }
  const outSnoozes: SnoozeEntry[] = [];
  for (const item of snoozes) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['originId'] !== 'string' || typeof item['fireAt'] !== 'string' || !isLocalDateTime(item['fireAt'])) return { state: 'unreadable' };
    outSnoozes.push({ id: item['id'], originId: item['originId'], fireAt: item['fireAt'] });
  }
  return { state: 'valid', queue: { v: 1, entries: outEntries, applied: outApplied, snoozes: outSnoozes, dropped, lost } };
}

/** Clé d'idempotence : identifiant stable (sinon numérique), action, instant de la notification livrée (sinon de la réponse). */
export function actionKey(action: Pick<RawNotificationAction, 'sid' | 'numericId' | 'actionId' | 'deliveredAt' | 'receivedAtMs'>): string {
  const who = action.sid !== null && action.sid !== '' ? action.sid : `n:${String(action.numericId)}`;
  return `${who}|${action.actionId}|${String(action.deliveredAt ?? action.receivedAtMs)}`;
}

export function compareEntries(a: ActionQueueEntry, b: ActionQueueEntry): number {
  return a.receivedAt - b.receivedAt || compareCodeUnits(a.key, b.key);
}

/** Retire de `applied` les clés trop anciennes (30 jours) et au-delà de 200 (les plus anciennes d'abord). */
export function trimApplied(applied: NotificationActionQueueV1['applied'], nowMs: number): NotificationActionQueueV1['applied'] {
  const fresh = applied.filter((item) => nowMs - item.at < ACTION_APPLIED_TTL_MS);
  return fresh.length > ACTION_QUEUE_MAX_APPLIED ? fresh.slice(fresh.length - ACTION_QUEUE_MAX_APPLIED) : fresh;
}

export interface EnqueueResult {
  readonly queue: NotificationActionQueueV1;
  /** Actions nouvelles inscrites. */
  readonly added: number;
  /** Actions écartées parce que déjà dans la file ou déjà appliquées (idempotence). */
  readonly duplicates: number;
}

/**
 * Inscrit des actions reçues : une clé déjà dans `entries` ou `applied` est écartée ; file pleine : la plus ancienne est écartée et
 * `dropped` augmente (visible). `lost` = lignes illisibles ou écritures impossibles comptées par le natif.
 */
export function enqueueActions(queue: NotificationActionQueueV1, received: readonly RawNotificationAction[], lost: number, nowMs: number): EnqueueResult {
  const known = new Set<string>([...queue.entries.map((entry) => entry.key), ...queue.applied.map((item) => item.key)]);
  const entries = [...queue.entries];
  let added = 0;
  let duplicates = 0;
  let dropped = queue.dropped;
  for (const action of received) {
    const key = actionKey(action);
    if (known.has(key)) {
      duplicates += 1;
      continue;
    }
    known.add(key);
    entries.push({ key, sid: action.sid, numericId: action.numericId, action: action.actionId, receivedAt: action.receivedAtMs, tries: 0, lastError: null });
    added += 1;
  }
  entries.sort(compareEntries);
  while (entries.length > ACTION_QUEUE_MAX_ENTRIES) {
    entries.shift();
    dropped += 1;
  }
  return { queue: { ...queue, entries, applied: trimApplied(queue.applied, nowMs), dropped, lost: queue.lost + lost }, added, duplicates };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cible d'une action
// ---------------------------------------------------------------------------------------------------------------------------------

const SNOOZE_PREFIX = 'snooze:';

/** Identifiant d'une répétition : `snooze:{origine}` ; l'origine d'une répétition est l'origine première. */
export const snoozeNotificationId = (originId: string): string => `${SNOOZE_PREFIX}${originOf(originId)}`;

/** Identifiant stable d'origine : celui d'une répétition sans son préfixe, sinon lui-même. */
export function originOf(sid: string): string {
  let origin = sid;
  while (origin.startsWith(SNOOZE_PREFIX)) origin = origin.slice(SNOOZE_PREFIX.length);
  return origin;
}

export type ActionTarget =
  | { readonly kind: 'task'; readonly reminderId: string }
  | { readonly kind: 'routine'; readonly reminderId: string; readonly date: LocalDate }
  | { readonly kind: 'event'; readonly reminderId: string; readonly date: LocalDate }
  /** Récapitulatif ou fin de Focus : jamais d'action proposée. */
  | { readonly kind: 'none' };

/** Cible d'un identifiant stable (ADR 0012 §3.1), répétitions résolues sur leur origine ; null si le format est inconnu. */
export function parseActionTarget(sid: string): ActionTarget | null {
  const origin = originOf(sid);
  const parts = origin.split(':');
  const [kind, reminderId, date] = parts;
  if (kind === 'recap' || kind === 'focus') return { kind: 'none' };
  if (reminderId === undefined || reminderId === '') return null;
  if (kind === 'task' && parts.length === 2) return { kind: 'task', reminderId };
  if ((kind === 'routine' || kind === 'event') && parts.length === 3 && date !== undefined && isLocalDate(date)) return { kind, reminderId, date };
  return null;
}

/**
 * Échéance de la répétition (heure locale flottante de `receivedAt + 15 min`, arrondie à la minute SUIVANTE : jamais plus tôt que demandé).
 * Si elle n'est plus à venir à l'application (app ouverte longtemps après), maintenant + 2 min.
 */
export function snoozeFireAt(receivedAtMs: number, nowMs: number, zone: string | null): LocalDateTime {
  const ceilMinute = (ms: number): number => Math.ceil(ms / 60_000) * 60_000;
  const wanted = ceilMinute(receivedAtMs + SNOOZE_DELAY_MS);
  const nowMinute = localDateTimeAt(nowMs, zone);
  const wantedLocal = localDateTimeAt(wanted, zone);
  return wantedLocal > nowMinute ? wantedLocal : localDateTimeAt(ceilMinute(nowMs + SNOOZE_LATE_FALLBACK_MS), zone);
}

/** Ajoute ou remplace la répétition de l'origine (une seule par origine), 100 au plus (les plus proches d'abord). */
export function upsertSnooze(snoozes: readonly SnoozeEntry[], sid: string, fireAt: LocalDateTime): readonly SnoozeEntry[] {
  const originId = originOf(sid);
  const id = snoozeNotificationId(originId);
  const next = [...snoozes.filter((snooze) => snooze.id !== id), { id, originId, fireAt }];
  next.sort((a, b) => compareCodeUnits(a.fireAt, b.fireAt) || compareCodeUnits(a.id, b.id));
  return next.slice(0, ACTION_QUEUE_MAX_SNOOZES);
}

/** Une file « en échec » : entrée non appliquée avec une erreur, compteurs de pertes. */
export function queueTrouble(queue: NotificationActionQueueV1): { readonly failing: number; readonly dropped: number; readonly lost: number } {
  return { failing: queue.entries.filter((entry) => entry.lastError !== null).length, dropped: queue.dropped, lost: queue.lost };
}

export const hasQueueTrouble = (queue: NotificationActionQueueV1): boolean => queue.entries.some((entry) => entry.lastError !== null) || queue.dropped > 0 || queue.lost > 0;

/** « Ignorer » : retire les entrées en échec et remet les compteurs à zéro. */
export function dismissQueueTrouble(queue: NotificationActionQueueV1): NotificationActionQueueV1 {
  return { ...queue, entries: queue.entries.filter((entry) => entry.lastError === null), dropped: 0, lost: 0 };
}

/** Catégories de notification par nature (`actionTypeId` envoyé avec `show`, enregistrées par le plugin d'actions). */
export const ACTION_TYPE_ID = { task: 'ct.task', routine: 'ct.routine', event: 'ct.event' } as const;

/** Actions proposées par catégorie : « Fait » n'a pas de sens pour un événement (décision du 2026-10-08). */
export const ACTIONS_BY_CATEGORY: Readonly<Record<keyof typeof ACTION_TYPE_ID, readonly NotificationActionId[]>> = {
  task: ['done', 'snooze15'],
  routine: ['done', 'snooze15'],
  event: ['snooze15'],
};
