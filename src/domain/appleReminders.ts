import { formatHlc } from './hlc';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, LocalTime, SpaceId } from './types';
import { isIsoDateTime, isLocalDate, isLocalTime } from './types';

/**
 * Rappels Apple (K-05 à K-07, ADR 0008 §10) : règles pures. Aucune I/O.
 *
 * Une tâche liée à un rappel porte `source = 'apple_reminders'` et l'identifiant EventKit dans `external_id` (publiés, donc visibles
 * sur le PC) ; la liste d'origine est dans `apple_list_id`. Le lien local (`apple_reminder_link`) et l'empreinte du dernier passage ne
 * sortent jamais de l'iPhone. Ce module décide : état d'une tâche, valeurs comparées, fusion par champ avec conflit, garde de
 * suppression, tâches à suivre, validation des réglages (valeurs venues de la synchro, donc non fiables).
 */

/** Appareil fictif des valeurs perdues côté Rappels dans le journal des conflits (UUID réservé, ADR 0008 §10.5). */
export const APPLE_REMINDERS_PSEUDO_DEVICE = '00000000-0000-4000-8000-0000000000ae' as DeviceId;
/** Identifiant d'appareil écrit dans le journal des conflits pour une valeur qui vient de Rappels (affiché « Rappels Apple »). */
export const APPLE_REMINDERS_DEVICE = 'apple-reminders';
export const MAX_APPLE_LISTS = 100;
/** Rappels non terminés lus par liste et par passage (ADR 0008 §10.6). */
export const MAX_REMINDERS_PER_LIST = 500;
/** Une tâche terminée depuis moins de 30 jours reste suivie (lecture par identifiant). */
export const FOLLOW_DONE_DAYS = 30;
/** Longueur maximale d'un titre (catalogue de synchro : `text` 4 096). */
export const MAX_TITLE_LENGTH = 4_096;
export const MAX_LIST_NAME_LENGTH = 200;
export const MAX_LIST_ID_LENGTH = 512;
/** Une écriture de `lastPassAt` au plus tous les 15 minutes (K-05 critère 14). */
export const LAST_PASS_WRITE_INTERVAL_MS = 15 * 60_000;
export const MAX_NOTICES = 20;

// ---------------------------------------------------------------------------------------------------------------------------------
// Contrat du plugin (types partagés avec src/platform/reminders)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Accès aux Rappels ; `writeOnly` (sans objet pour des rappels) est ramené à `denied` par l'adaptateur. */
export type RemindersAccess = 'not-determined' | 'denied' | 'restricted' | 'full';

export interface ReminderList {
  readonly id: string;
  readonly name: string;
  readonly writable: boolean;
}

/** Échéance : heure murale du fuseau courant (Swift convertit un `dueDateComponents` avec fuseau). */
export interface ReminderDue {
  readonly date: LocalDate;
  readonly time: LocalTime | null;
}

export interface ReminderItem {
  readonly id: string;
  readonly externalRef: string | null;
  readonly listId: string;
  readonly title: string;
  readonly due: ReminderDue | null;
  readonly completed: boolean;
  readonly completedAt: IsoDateTime | null;
  /** `hasRecurrenceRules`. */
  readonly recurring: boolean;
  readonly modifiedAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// États d'une tâche
// ---------------------------------------------------------------------------------------------------------------------------------

export type AppleLinkState = 'ordinary' | 'linked' | 'to-create' | 'detached';

export interface AppleTaskFacts {
  readonly source: 'local' | 'apple_reminders';
  readonly externalId: string | null;
  readonly appleListId: string | null;
}

/** ordinaire / liée / à créer dans Rappels (K-06) / détachée (K-07 critère 8) : voir le tableau de l'ADR 0008 §10.2. */
export function appleLinkState(task: AppleTaskFacts): AppleLinkState {
  if (task.source === 'apple_reminders') return task.externalId !== null ? 'linked' : task.appleListId !== null ? 'to-create' : 'ordinary';
  return task.externalId === null && task.appleListId !== null ? 'detached' : 'ordinary';
}

export const isAppleLinked = (task: AppleTaskFacts): boolean => appleLinkState(task) === 'linked';

/** Refus d'une écriture sur une tâche liée à un rappel récurrent (ADR 0008 §10.6) : titre, date, heure, case, suppression. */
export function isAppleRecurringLocked(task: AppleTaskFacts & { readonly appleRecurring: boolean }): boolean {
  return appleLinkState(task) === 'linked' && task.appleRecurring;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Valeurs comparées
// ---------------------------------------------------------------------------------------------------------------------------------

export interface AppleValues {
  readonly title: string;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly completed: boolean;
  readonly doneAt: IsoDateTime | null;
}

export interface TaskValuesSource {
  readonly title: string;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly status: 'todo' | 'done';
  readonly doneAt: IsoDateTime | null;
}

export function valuesOfTask(task: TaskValuesSource): AppleValues {
  return { title: task.title, date: task.date, time: task.time, completed: task.status === 'done', doneAt: task.doneAt };
}

/** Titre d'un rappel tel que la tâche le porte : tronqué à la limite du catalogue, vide : texte de repli. */
export function titleFromApple(raw: string, untitled: string): string {
  const trimmed = raw.trim();
  return trimmed === '' ? untitled : trimmed.slice(0, MAX_TITLE_LENGTH);
}

/** Valeurs côté Rappels (`someday` suit : pas d'échéance = « Un jour », avec échéance = pas « Un jour »). */
export function valuesOfItem(item: ReminderItem, untitled: string): AppleValues {
  return {
    title: titleFromApple(item.title, untitled),
    date: item.due?.date ?? null,
    time: item.due?.time ?? null,
    completed: item.completed,
    doneAt: item.completed ? item.completedAt : null,
  };
}

/** Mêmes valeurs comparées (titre, échéance, heure, statut) ; la date d'achèvement ne compte pas. */
export function sameAppleValues(a: AppleValues, b: AppleValues): boolean {
  return a.title === b.title && a.date === b.date && a.time === b.time && a.completed === b.completed;
}

/**
 * La tâche porte-t-elle une modification LOCALE par rapport à la dernière empreinte ? La date d'une tâche reportée par T-06 (`carriedOver`) n'en est pas
 * une (même règle que `mergeLinked`) : elle ne repart jamais vers Rappels et ne compte pas comme « modifiée localement ».
 */
export function differsFromSynced(task: TaskValuesSource & { readonly carriedOver: boolean }, synced: AppleValues): boolean {
  const local = valuesOfTask(task);
  return !sameAppleValues(task.carriedOver ? { ...local, date: synced.date } : local, synced);
}

export function encodeSynced(values: AppleValues): string {
  return JSON.stringify(values);
}

/** Empreinte lue en base ; illisible ou invalide : `null` (traitée comme inconnue, chaque différence devient un conflit). */
export function parseSynced(json: string | null): AppleValues | null {
  if (json === null) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const { title, date, time, completed, doneAt } = raw;
    if (typeof title !== 'string' || typeof completed !== 'boolean') return null;
    if (date !== null && !(typeof date === 'string' && isLocalDate(date))) return null;
    if (time !== null && !(typeof time === 'string' && isLocalTime(time))) return null;
    if (doneAt !== null && !(typeof doneAt === 'string' && isIsoDateTime(doneAt))) return null;
    return { title, date: date as LocalDate | null, time: time as LocalTime | null, completed, doneAt: doneAt as IsoDateTime | null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fusion par champ (ADR 0008 §10.5)
// ---------------------------------------------------------------------------------------------------------------------------------

export type MergeField = 'title' | 'date' | 'time' | 'status';
export const MERGE_FIELDS: readonly MergeField[] = ['title', 'date', 'time', 'status'];

/** Valeur d'un champ dans le journal des conflits (JSON de la valeur, `status` : `todo` ou `done`). */
export type ConflictValue = string | null;

export interface FieldConflict {
  readonly field: MergeField;
  /** `apple` : la valeur de Rappels est gardée, la valeur locale est écartée ; `local` : l'inverse. */
  readonly winner: 'apple' | 'local';
  readonly kept: ConflictValue;
  readonly discarded: ConflictValue;
  /** Instant (ms) de l'écriture écartée : `modifiedAt` de l'élément, ou horloge du champ local ; sert de hlc écarté. */
  readonly discardedAtMs: number | null;
}

export interface MergeInput {
  readonly task: AppleValues;
  /** La date de la tâche est un report automatique (T-06) : jamais renvoyée vers Rappels. */
  readonly carriedOver: boolean;
  readonly item: AppleValues;
  readonly synced: AppleValues | null;
  /** `modifiedAt` de l'élément (ms) ; `null` : inconnu. */
  readonly appleModifiedMs: number | null;
  /** Heure physique (ms) de l'horloge de chaque champ local ; `null` : inconnue. */
  readonly localMs: Readonly<Record<MergeField, number | null>>;
  /**
   * Rappel récurrent (ADR 0008 §10.6) : aucune écriture vers Rappels. Une valeur locale arrivée malgré tout (version plus ancienne, conflit
   * restauré) est remplacée par celle de Rappels et inscrite dans le journal des conflits.
   */
  readonly locked?: boolean;
}

export interface MergeResult {
  /** Valeurs à écrire dans la tâche (cas d'usage existants). `carriedOver: false` : la date vient de Rappels. */
  readonly toTask: { readonly title?: string; readonly date?: LocalDate | null; readonly time?: LocalTime | null; readonly completed?: boolean; readonly doneAt?: IsoDateTime | null; readonly carriedOver?: false };
  /** Valeurs à écrire dans le rappel. */
  readonly toApple: { readonly title?: string; readonly date?: LocalDate | null; readonly time?: LocalTime | null; readonly completed?: boolean; readonly doneAt?: IsoDateTime | null };
  readonly conflicts: readonly FieldConflict[];
  /** Valeurs communes après les deux écritures : nouvelle empreinte. */
  readonly next: AppleValues;
  /** Rien à écrire de part ni d'autre. */
  readonly idle: boolean;
}

const fieldValue = (field: MergeField, values: AppleValues): string | boolean | null => (field === 'status' ? values.completed : values[field]);

function conflictText(field: MergeField, values: AppleValues): ConflictValue {
  switch (field) {
    case 'title':
      return values.title;
    case 'date':
      return values.date;
    case 'time':
      return values.time;
    case 'status':
      return values.completed ? 'done' : 'todo';
  }
}

/**
 * Pour chaque champ : un seul côté a changé depuis l'empreinte, il gagne ; les deux avec la même valeur : rien à écrire ; les deux
 * avec des valeurs différentes : le plus récent gagne (à égalité ou si l'heure de Rappels est inconnue, Rappels), la valeur perdue
 * est rendue dans `conflicts` pour le journal. Empreinte inconnue : chaque champ différent est un conflit. La date reportée par T-06
 * n'est jamais une modification locale (D5).
 */
export function mergeLinked(input: MergeInput): MergeResult {
  const { task, item, synced } = input;
  const toTask: { -readonly [K in keyof MergeResult['toTask']]: MergeResult['toTask'][K] } = {};
  const toApple: { -readonly [K in keyof MergeResult['toApple']]: MergeResult['toApple'][K] } = {};
  const conflicts: FieldConflict[] = [];
  const kept: { title: string; date: LocalDate | null; time: LocalTime | null; completed: boolean; doneAt: IsoDateTime | null } = { ...item };

  for (const field of MERGE_FIELDS) {
    const local = fieldValue(field, task);
    const remote = fieldValue(field, item);
    if (local === remote) {
      if (field === 'status') kept.doneAt = task.completed ? (task.doneAt ?? item.doneAt) : null;
      continue;
    }
    const base = synced === null ? undefined : fieldValue(field, synced);
    const localChanged = synced === null || (local !== base && !(field === 'date' && input.carriedOver));
    const appleChanged = synced === null || remote !== base;
    if (!localChanged && !appleChanged) continue; // date reportée : elle reste locale, l'empreinte garde la valeur de Rappels
    let winner: 'apple' | 'local';
    if (input.locked === true && localChanged) {
      // Rappel récurrent : Rappels gagne toujours, la valeur locale est gardée dans le journal.
      winner = 'apple';
      conflicts.push({ field, winner, kept: conflictText(field, item), discarded: conflictText(field, task), discardedAtMs: input.localMs[field] });
    } else if (localChanged && appleChanged) {
      const localAt = input.localMs[field];
      winner = localAt !== null && (input.appleModifiedMs === null || localAt > input.appleModifiedMs) ? 'local' : 'apple';
      conflicts.push({
        field,
        winner,
        kept: conflictText(field, winner === 'apple' ? item : task),
        discarded: conflictText(field, winner === 'apple' ? task : item),
        discardedAtMs: winner === 'apple' ? localAt : input.appleModifiedMs,
      });
    } else {
      winner = appleChanged ? 'apple' : 'local';
    }
    if (winner === 'apple') {
      applyTo(toTask, field, item);
      if (field === 'date') toTask.carriedOver = false;
    } else {
      applyTo(toApple, field, task);
      applyTo(kept, field, task);
    }
  }

  // Invariant : pas d'heure sans date, ni pour la tâche ni pour le rappel.
  const taskDate = 'date' in toTask ? (toTask.date ?? null) : task.date;
  const taskTime = 'time' in toTask ? (toTask.time ?? null) : task.time;
  if (taskDate === null && taskTime !== null) toTask.time = null;
  const appleDate = 'date' in toApple ? (toApple.date ?? null) : item.date;
  const appleTime = 'time' in toApple ? (toApple.time ?? null) : item.time;
  if (appleDate === null && appleTime !== null) toApple.time = null;
  if (kept.date === null) kept.time = null;

  const next: AppleValues = { title: kept.title, date: kept.date, time: kept.time, completed: kept.completed, doneAt: kept.completed ? (kept.doneAt ?? task.doneAt ?? item.doneAt) : null };
  const idle = Object.keys(toTask).length === 0 && Object.keys(toApple).length === 0;
  return { toTask, toApple, conflicts, next, idle };
}

function applyTo(target: Record<string, unknown>, field: MergeField, from: AppleValues): void {
  switch (field) {
    case 'title':
      target['title'] = from.title;
      return;
    case 'date':
      target['date'] = from.date;
      return;
    case 'time':
      target['time'] = from.time;
      return;
    case 'status':
      target['completed'] = from.completed;
      target['doneAt'] = from.completed ? from.doneAt : null;
      return;
  }
}

/** HLC synthétique d'une valeur perdue côté Rappels : `<modifiedAt en ms sur 15 chiffres>-0000-<appareil fictif>` (ADR 0008 §10.5). */
export function syntheticHlc(ms: number | null): Hlc {
  return formatHlc({ ms: ms === null || !Number.isSafeInteger(ms) || ms < 0 ? 0 : ms, counter: 0, deviceId: APPLE_REMINDERS_PSEUDO_DEVICE });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression, suivi, plafond
// ---------------------------------------------------------------------------------------------------------------------------------

/** Garde de suppression massive : plus de `max(10, 25 %)` des tâches liées d'une liste absentes ⇒ rien n'est supprimé sans geste. */
export function massDeletionBlocked(linkedInList: number, absent: number): boolean {
  return absent > Math.max(10, Math.floor(linkedInList / 4));
}

export interface FollowFacts {
  readonly status: 'todo' | 'done';
  readonly doneAt: IsoDateTime | null;
  readonly updatedAt: IsoDateTime;
}

/** Suivi borné : tâches à faire, terminées depuis moins de 30 jours, ou modifiées localement depuis le dernier passage. */
export function isFollowed(task: FollowFacts, nowMs: number, lastPassAt: IsoDateTime | null): boolean {
  if (task.status === 'todo') return true;
  if (task.doneAt !== null && nowMs - Date.parse(task.doneAt) < FOLLOW_DONE_DAYS * 86_400_000) return true;
  return lastPassAt === null || task.updatedAt > lastPassAt;
}

/** Date locale et heure d'un rappel vers les champs de la tâche (`someday` : pas d'échéance). */
export function taskScheduleOf(values: Pick<AppleValues, 'date' | 'time'>): { date: LocalDate | null; time: LocalTime | null; someday: boolean } {
  return values.date === null ? { date: null, time: null, someday: true } : { date: values.date, time: values.time, someday: false };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Réglages (partagés : validés comme toute valeur venue d'un autre appareil)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface AppleListSetting {
  readonly id: string;
  readonly name: string;
  readonly spaceId: SpaceId | null;
  readonly shown: boolean;
}

export interface AppleListsSetting {
  readonly lists: readonly AppleListSetting[];
}

export interface AppleCreateRule {
  readonly spaceId: SpaceId;
  readonly enabled: boolean;
  readonly listId: string | null;
}

export interface AppleCreateSetting {
  readonly bySpace: readonly AppleCreateRule[];
}

export interface ApplePending {
  readonly count: number;
  readonly at: IsoDateTime;
}

export type AppleNoticeKind =
  | 'deleted'
  | 'detached'
  | 'detached-recurring'
  | 'unlinked-list'
  | 'creation-off'
  | 'read-only-list'
  | 'recurring-refused'
  | 'duplicate-created'
  | 'listener-failed';

/** Message à afficher dans l'écran Agendas ; jamais de titre. */
export interface AppleNotice {
  readonly kind: AppleNoticeKind;
  readonly count: number;
  readonly at: IsoDateTime;
  readonly listId?: string;
}

export interface AppleStatus {
  /** Échec persistant ; `write` : une écriture vers Rappels n'a pas pu partir (le bandeau compte les modifications non envoyées). */
  readonly failure: { readonly code: string; readonly at: IsoDateTime; readonly write?: true } | null;
  readonly caps: readonly { readonly listId: string; readonly total: number; readonly imported: number }[];
  /** Retenues de la garde de suppression massive ; `send` : suppressions de tâches ICI qui effaceraient des rappels (sinon : rappels absents de Rappels). */
  readonly held: readonly { readonly listId: string; readonly count: number; readonly at: IsoDateTime; readonly send?: true }[];
  readonly unknown: number;
  readonly missingLists: readonly string[];
  readonly notices: readonly AppleNotice[];
}

export const EMPTY_APPLE_LISTS: AppleListsSetting = { lists: [] };
export const EMPTY_APPLE_CREATE: AppleCreateSetting = { bySpace: [] };
export const EMPTY_APPLE_STATUS: AppleStatus = { failure: null, caps: [], held: [], unknown: 0, missingLists: [], notices: [] };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is SpaceId => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const isShortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseAppleLists(raw: unknown): AppleListsSetting {
  if (!isObject(raw) || !Array.isArray(raw['lists'])) return EMPTY_APPLE_LISTS;
  const seen = new Set<string>();
  const lists: AppleListSetting[] = [];
  for (const entry of raw['lists'].slice(0, MAX_APPLE_LISTS) as unknown[]) {
    if (!isObject(entry) || !isShortText(entry['id'], MAX_LIST_ID_LENGTH) || seen.has(entry['id'])) continue;
    const name = typeof entry['name'] === 'string' ? entry['name'].slice(0, MAX_LIST_NAME_LENGTH) : '';
    const spaceId = isUuid(entry['spaceId']) ? entry['spaceId'] : null;
    // `shown` exige un espace (ES-06).
    const shown = entry['shown'] === true && spaceId !== null;
    seen.add(entry['id']);
    lists.push({ id: entry['id'], name, spaceId, shown });
  }
  return { lists };
}

export function parseAppleCreate(raw: unknown): AppleCreateSetting {
  if (!isObject(raw) || !Array.isArray(raw['bySpace'])) return EMPTY_APPLE_CREATE;
  const seen = new Set<string>();
  const bySpace: AppleCreateRule[] = [];
  for (const entry of raw['bySpace'].slice(0, 20) as unknown[]) {
    if (!isObject(entry) || !isUuid(entry['spaceId']) || seen.has(entry['spaceId'])) continue;
    const listId = isShortText(entry['listId'], MAX_LIST_ID_LENGTH) ? entry['listId'] : null;
    seen.add(entry['spaceId']);
    bySpace.push({ spaceId: entry['spaceId'], enabled: entry['enabled'] === true && listId !== null, listId });
  }
  return { bySpace };
}

export function parseApplePending(raw: unknown): ApplePending | null {
  if (!isObject(raw) || !isCount(raw['count']) || typeof raw['at'] !== 'string' || !isIsoDateTime(raw['at'])) return null;
  return { count: raw['count'], at: raw['at'] };
}

export function parseLastPassAt(raw: unknown): IsoDateTime | null {
  return typeof raw === 'string' && isIsoDateTime(raw) ? raw : null;
}

export function parseAppleStatus(raw: unknown): AppleStatus {
  if (!isObject(raw)) return EMPTY_APPLE_STATUS;
  const failure =
    isObject(raw['failure']) && isShortText(raw['failure']['code'], 64) && typeof raw['failure']['at'] === 'string' && isIsoDateTime(raw['failure']['at'])
      ? { code: raw['failure']['code'], at: raw['failure']['at'], ...(raw['failure']['write'] === true ? { write: true as const } : {}) }
      : null;
  const caps = (Array.isArray(raw['caps']) ? (raw['caps'] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && isShortText(entry['listId'], MAX_LIST_ID_LENGTH) && isCount(entry['total']) && isCount(entry['imported']))
    .slice(0, MAX_APPLE_LISTS)
    .map((entry) => ({ listId: entry['listId'] as string, total: entry['total'] as number, imported: entry['imported'] as number }));
  const held = (Array.isArray(raw['held']) ? (raw['held'] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && isShortText(entry['listId'], MAX_LIST_ID_LENGTH) && isCount(entry['count']) && typeof entry['at'] === 'string' && isIsoDateTime(entry['at']))
    .slice(0, MAX_APPLE_LISTS)
    .map((entry) => ({ listId: entry['listId'] as string, count: entry['count'] as number, at: entry['at'] as IsoDateTime, ...(entry['send'] === true ? { send: true as const } : {}) }));
  const missingLists = (Array.isArray(raw['missingLists']) ? (raw['missingLists'] as unknown[]) : []).filter((id): id is string => isShortText(id, MAX_LIST_ID_LENGTH)).slice(0, MAX_APPLE_LISTS);
  const kinds: readonly string[] = ['deleted', 'detached', 'detached-recurring', 'unlinked-list', 'creation-off', 'read-only-list', 'recurring-refused', 'duplicate-created', 'listener-failed'];
  const notices = (Array.isArray(raw['notices']) ? (raw['notices'] as unknown[]) : [])
    .filter((entry): entry is Record<string, unknown> => isObject(entry) && typeof entry['kind'] === 'string' && kinds.includes(entry['kind']) && isCount(entry['count']) && typeof entry['at'] === 'string' && isIsoDateTime(entry['at']))
    .slice(0, MAX_NOTICES)
    .map((entry): AppleNotice => ({ kind: entry['kind'] as AppleNoticeKind, count: entry['count'] as number, at: entry['at'] as IsoDateTime, ...(isShortText(entry['listId'], MAX_LIST_ID_LENGTH) ? { listId: entry['listId'] } : {}) }));
  return { failure, caps, held, unknown: isCount(raw['unknown']) ? raw['unknown'] : 0, missingLists, notices };
}

/** Liste de destination valable d'un espace : activée, liste affichée de cet espace et écrivable. */
export function createTargetFor(spaceId: SpaceId, create: AppleCreateSetting, lists: AppleListsSetting): string | null {
  const rule = create.bySpace.find((entry) => entry.spaceId === spaceId);
  if (!rule || !rule.enabled || rule.listId === null) return null;
  const list = lists.lists.find((entry) => entry.id === rule.listId);
  return list && list.shown && list.spaceId === spaceId ? list.id : null;
}

/** Réglage de création d'un espace : refus d'activer sans liste affichée de cet espace (K-06 critère 6). */
export type CreateRuleError = 'no-list' | 'list-not-in-space';

export function validateCreateRule(spaceId: SpaceId, listId: string | null, lists: AppleListsSetting): CreateRuleError | null {
  if (listId === null) return 'no-list';
  const list = lists.lists.find((entry) => entry.id === listId);
  return list && list.shown && list.spaceId === spaceId ? null : 'list-not-in-space';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PC (K-07) : fraîcheur des Rappels lus par l'iPhone, modifications en attente d'envoi
// ---------------------------------------------------------------------------------------------------------------------------------

/** Au-delà de 24 h sans lecture réussie par l'iPhone, le PC avertit (K-07 D1). */
export const STALE_AFTER_MS = 24 * 3_600_000;

export type AppleFreshness = 'fresh' | 'stale' | 'never' | 'no-iphone';

/**
 * État de fraîcheur affiché sur le PC (K-07 critère 5, D1) : `no-iphone` : aucun iPhone associé (ou synchro non configurée) ; `never` :
 * aucune lecture n'a encore eu lieu ; `stale` : plus de 24 h (24 h exactement n'avertit pas) ; sinon `fresh`. Fonction pure, sans horloge globale.
 */
export function appleFreshness(input: { readonly nowMs: number; readonly lastPassAt: IsoDateTime | null; readonly iphoneAssociated: boolean }): AppleFreshness {
  if (!input.iphoneAssociated) return 'no-iphone';
  if (input.lastPassAt === null) return 'never';
  return input.nowMs - Date.parse(input.lastPassAt) > STALE_AFTER_MS ? 'stale' : 'fresh';
}

/**
 * Une modification de titre, d'échéance ou de statut faite sur le PC attend-elle le prochain passage de l'iPhone (K-07 D2) ? Vrai si l'une
 * des horloges de ces champs (ms) est plus récente que la dernière lecture publiée par l'iPhone. Une note ou un projet modifié ne compte pas.
 */
export function awaitsIphonePass(fieldClocksMs: readonly number[], lastPassAt: IsoDateTime | null): boolean {
  if (lastPassAt === null) return false;
  const last = Date.parse(lastPassAt);
  return fieldClocksMs.some((ms) => ms > last);
}

/** Appareil tel que l'affiche la synchro (sous-ensemble de `SyncDeviceStatus`, comme `WarningDevice` de N-07). */
export interface AssociationDevice {
  readonly platform: 'windows' | 'ios';
  readonly self: boolean;
  readonly status: string;
  readonly seen?: boolean | undefined;
}

/**
 * Un iPhone est-il associé (K-07 critère 5) ? Un appareil iOS autre que soi, déjà lu, ni oublié ni expiré ; sans synchro configurée (liste
 * vide) : non. Un iPhone dont la synchro est en erreur reste associé : c'est alors la fraîcheur qui avertit.
 */
export function hasAssociatedIphone(devices: readonly AssociationDevice[]): boolean {
  return devices.some((device) => device.platform === 'ios' && !device.self && device.seen !== false && device.status !== 'forgotten' && device.status !== 'expired');
}

/** Fenêtre d'annulation (T-13, 5 s) : aucune écriture vers Rappels pour une tâche dont la dernière écriture locale est plus récente. */
export const UNDO_WINDOW_MS = 5_000;

/** Temps restant (ms) de la fenêtre d'annulation après une écriture locale à `at` ; 0 : la fenêtre est écoulée (ou aucune écriture connue). */
export function holdRemainingMs(at: IsoDateTime | null, nowMs: number): number {
  if (at === null) return 0;
  const age = nowMs - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age < UNDO_WINDOW_MS ? UNDO_WINDOW_MS - age : 0;
}

/** Le réglage partagé des listes est-il exploitable ? Une valeur absente (jamais écrite) ou de la bonne forme l'est ; tout autre contenu non (ne jamais le lire comme « aucune liste »). */
export function appleListsReadable(raw: unknown): boolean {
  return raw === null || raw === undefined || (isObject(raw) && Array.isArray(raw['lists']));
}
