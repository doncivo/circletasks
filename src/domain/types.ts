/**
 * Types de base partagés par toutes les couches (contrat d'architecture, ADR 0001).
 *
 * Règle : ce fichier ne dépend de rien. Les types « marqués » (branded) empêchent
 * de passer une chaîne quelconque là où un identifiant ou une date locale est attendu.
 * Les valeurs se construisent uniquement via les fonctions de garde / conversion
 * (`asId`, `asLocalDate`, `asLocalTime`…) ou par lecture depuis un repository.
 */

declare const brand: unique symbol;

/** Type marqué : `Brand<string, 'Id'>` est une chaîne mais pas l'inverse. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Identifiant UUID (v4, minuscules, format canonique 8-4-4-4-12). */
export type Id = Brand<string, 'Id'>;

/** Identifiant d'un espace (ligne de la table `space`, ex. Pro ou Perso). */
export type SpaceId = Brand<Id, 'SpaceId'>;

/** Identifiant d'appareil (UUID généré au premier lancement, stocké localement). */
export type DeviceId = Brand<Id, 'DeviceId'>;

/*
 * Identifiants typés par entité (ADR 0004) : un `TaskId` ne peut pas être passé là
 * où un `RoutineId` est attendu. Construction : `asEntityId<TaskId>(texte)` ou
 * `newEntityId<TaskId>(ids)` (src/domain/id.ts).
 */
export type ProjectId = Brand<Id, 'ProjectId'>;
export type TaskId = Brand<Id, 'TaskId'>;
export type RecurrenceId = Brand<Id, 'RecurrenceId'>;
export type RoutineId = Brand<Id, 'RoutineId'>;
export type RoutineLogId = Brand<Id, 'RoutineLogId'>;
export type RoutinePauseId = Brand<Id, 'RoutinePauseId'>;
export type ReminderId = Brand<Id, 'ReminderId'>;
export type GoalId = Brand<Id, 'GoalId'>;
export type EventId = Brand<Id, 'EventId'>;
export type HolidayId = Brand<Id, 'HolidayId'>;
export type FocusSessionId = Brand<Id, 'FocusSessionId'>;
export type ChecklistId = Brand<Id, 'ChecklistId'>;
export type ChecklistItemId = Brand<Id, 'ChecklistItemId'>;
export type CalendarAccountId = Brand<Id, 'CalendarAccountId'>;
export type ExternalEventId = Brand<Id, 'ExternalEventId'>;

/** Date civile locale sans fuseau, 'YYYY-MM-DD'. */
export type LocalDate = Brand<string, 'LocalDate'>;

/** Heure locale flottante (sans fuseau), 24 h, 'HH:mm'. */
export type LocalTime = Brand<string, 'LocalTime'>;

/**
 * Date et heure locales flottantes (sans fuseau), 'YYYY-MM-DDTHH:mm'.
 * Sert aux échéances de rappel (`reminder.fire_at`) : 10:00 reste 10:00 dans le
 * fuseau où se trouve l'iPhone (T-11, N-06).
 */
export type LocalDateTime = Brand<string, 'LocalDateTime'>;

/** Instant UTC au format ISO 8601 avec millisecondes, ex. '2026-10-01T21:30:00.000Z'. */
export type IsoDateTime = Brand<string, 'IsoDateTime'>;

/**
 * Horloge logique hybride sérialisée, triable lexicographiquement : la plus grande
 * gagne. Format et générateur : src/domain/hlc.ts (ADR 0005).
 */
export type Hlc = Brand<string, 'Hlc'>;

/** Couleur '#rrggbb' en minuscules (espaces, projets). */
export type HexColor = Brand<string, 'HexColor'>;

/** Jour de semaine ISO 8601 : 1 = lundi … 7 = dimanche (la semaine commence le lundi). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Filtre d'espace appliqué partout : un espace précis ou « Tout ». */
export type SpaceFilter = SpaceId | 'all';

/**
 * Colonnes de synchronisation présentes sur chaque table métier synchronisée
 * (PRD section 6). Forme « ligne SQL » en snake_case : les repositories
 * convertissent vers les entités du domaine.
 */
export interface SyncColumns {
  readonly id: Id;
  readonly created_at: IsoDateTime;
  readonly updated_at: IsoDateTime;
  readonly deleted_at: IsoDateTime | null;
  readonly device_id: DeviceId;
  readonly hlc: Hlc;
}

/** Équivalent camelCase de `SyncColumns`, porté par les entités du domaine. */
export interface SyncMeta {
  readonly id: Id;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt: IsoDateTime | null;
  readonly deviceId: DeviceId;
  readonly hlc: Hlc;
}

/** Résultat explicite pour les règles métier qui peuvent refuser une entrée. */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

export function isId(value: string): value is Id {
  return UUID_RE.test(value);
}

export function isLocalDate(value: string): value is LocalDate {
  const m = LOCAL_DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // Jour 0 du mois suivant = dernier jour du mois courant (UTC pour éviter les fuseaux).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

export function isLocalTime(value: string): value is LocalTime {
  return LOCAL_TIME_RE.test(value);
}

export function isIsoDateTime(value: string): value is IsoDateTime {
  return ISO_DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isLocalDateTime(value: string): value is LocalDateTime {
  const [date, time, ...rest] = value.split('T');
  return rest.length === 0 && date !== undefined && time !== undefined && isLocalDate(date) && isLocalTime(time);
}

export function isHexColor(value: string): value is HexColor {
  return HEX_COLOR_RE.test(value);
}

export function isWeekday(value: number): value is Weekday {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

function assertFormat<T extends string>(value: string, guard: (v: string) => v is T, label: string): T {
  if (!guard(value)) throw new TypeError(`${label} invalide : « ${value} »`);
  return value;
}

export const asId = (value: string): Id => assertFormat(value, isId, 'Id');
export const asSpaceId = (value: string): SpaceId => asId(value) as SpaceId;
export const asDeviceId = (value: string): DeviceId => asId(value) as DeviceId;
export const asLocalDate = (value: string): LocalDate => assertFormat(value, isLocalDate, 'LocalDate');
export const asLocalTime = (value: string): LocalTime => assertFormat(value, isLocalTime, 'LocalTime');
export const asIsoDateTime = (value: string): IsoDateTime =>
  assertFormat(value, isIsoDateTime, 'IsoDateTime');
export const asLocalDateTime = (value: string): LocalDateTime =>
  assertFormat(value, isLocalDateTime, 'LocalDateTime');
export const asHexColor = (value: string): HexColor => assertFormat(value, isHexColor, 'HexColor');

/** Identifiant typé d'entité à partir d'un texte (lecture de base, paramètre de route). */
export function asEntityId<T extends Id>(value: string): T {
  return asId(value) as T;
}
