/**
 * Catalogue des tables et colonnes publiées par la synchronisation (ADR 0011, sections 3.2, 3.3, 4.2 et 8 ; Y-02, Y-09).
 *
 * Seule source des noms SQL de la synchro : déclencheurs de capture (migration 0015, copie figée contrôlée par test), publication,
 * application des opérations reçues et instantanés. Un nom reçu d'un autre appareil n'entre jamais dans une requête : il est cherché
 * ici (comparaison exacte, `Map` figée) et la requête est écrite avec le nom du catalogue (audit H5).
 *
 * Module pur : constantes, recherche et validation des valeurs. Aucune I/O.
 */

import { SETTINGS_DEFINITIONS, type SettingKey } from '../model/settings';
import { isId, isIsoDateTime, isLocalDate, isLocalTime } from '../types';
import { MAX_SYNC_ID_LENGTH } from './limits';
import { isNaturalId, type NaturalIdTable } from './naturalIds';
import { SYNC_TABLE_ORDER } from './format';

/** Types déclarés des colonnes publiées (section 3.3). */
export type SyncColumnType = 'text' | 'int' | 'real' | 'bool' | 'json' | 'date' | 'time' | 'datetime' | 'id' | 'enum';

export interface SyncColumn {
  readonly name: string;
  readonly type: SyncColumnType;
  readonly nullable: boolean;
  /** Longueur maximale (texte, JSON, identifiant). */
  readonly max?: number;
  /** Valeurs admises (`enum`) ou valeurs entières admises (`int`). */
  readonly values?: readonly (string | number)[];
  /** Faux : fusionné par hlc mais jamais montré dans le journal des conflits (section 4.2). */
  readonly conflictVisible: boolean;
}

export type SyncTableName = (typeof SYNC_TABLE_ORDER)[number];

/** Nature des identifiants d'une table : UUID, identifiant naturel déterministe (section 8) ou clé de réglage. */
export type SyncIdKind = 'uuid' | 'natural' | 'setting';

export interface SyncTable {
  readonly name: SyncTableName;
  /** Colonne de clé primaire : `id`, ou `key` pour `settings`. */
  readonly key: 'id' | 'key';
  readonly idKind: SyncIdKind;
  /** Colonnes publiées (ordre du catalogue), `created_at` et `deleted_at` compris quand la table les porte. */
  readonly columns: readonly SyncColumn[];
  /** Colonnes locales, jamais publiées (section 8). */
  readonly local: readonly string[];
  /** Vrai si une ligne supprimée peut être purgée physiquement (section 5.4 : jamais `settings` ni les espaces fixes). */
  readonly purgeable: boolean;
  /** Clés étrangères vers une table publiée (colonne → table) : ordre d'application et mise de côté (section 3.3). */
  readonly parents: readonly { readonly column: string; readonly table: SyncTableName }[];
}

/** Colonnes techniques présentes sur chaque table métier, qui ne circulent pas comme champs (section 3.1). */
export const TECHNICAL_COLUMNS = ['updated_at', 'device_id', 'hlc'] as const;

const SHORT_TEXT = 4_096;
const LONG_TEXT = 200 * 1_024;
const JSON_TEXT = 64 * 1_024;

const c = (name: string, type: SyncColumnType, nullable: boolean, extra: Partial<Omit<SyncColumn, 'name' | 'type' | 'nullable'>> = {}): SyncColumn => ({
  name,
  type,
  nullable,
  conflictVisible: true,
  ...(type === 'text' ? { max: SHORT_TEXT } : type === 'json' ? { max: JSON_TEXT } : type === 'id' ? { max: MAX_SYNC_ID_LENGTH } : {}),
  ...extra,
});
const hidden = { conflictVisible: false } as const;
const bool = (name: string, extra: Partial<SyncColumn> = {}): SyncColumn => c(name, 'bool', false, extra);
const createdAt = c('created_at', 'datetime', false, hidden);
const deletedAt = c('deleted_at', 'datetime', true);

const table = (
  name: SyncTableName,
  columns: readonly SyncColumn[],
  options: { local?: readonly string[]; parents?: SyncTable['parents']; idKind?: SyncIdKind; purgeable?: boolean; key?: 'id' | 'key' } = {},
): SyncTable => ({
  name,
  key: options.key ?? 'id',
  idKind: options.idKind ?? 'uuid',
  columns,
  local: options.local ?? [],
  purgeable: options.purgeable ?? true,
  parents: options.parents ?? [],
});

/** Catalogue, dans l'ordre topologique des tables (section 3.3). */
export const SYNC_TABLES: readonly SyncTable[] = [
  table('space', [c('name', 'text', false), c('color', 'text', false, { max: 16 }), c('sort_order', 'real', false, hidden), c('quiet_hours', 'json', false), createdAt, deletedAt]),
  table(
    'project',
    [c('space_id', 'id', false), c('name', 'text', false), c('color', 'text', false, { max: 16 }), bool('archived'), c('sort_order', 'real', false, hidden), createdAt, deletedAt],
    { parents: [{ column: 'space_id', table: 'space' }] },
  ),
  table('recurrence', [
    c('freq', 'enum', false, { values: ['daily', 'weekly', 'monthly', 'yearly'] }),
    c('interval', 'int', false),
    c('weekdays', 'json', false),
    c('month_day', 'int', true),
    c('nth_weekday', 'text', true, { max: 64 }),
    c('until', 'text', true, { max: 64 }),
    c('count', 'int', true),
    createdAt,
    deletedAt,
  ]),
  table(
    'goal',
    [
      c('space_id', 'id', false),
      c('week_start', 'date', false),
      c('title', 'text', false),
      c('icon', 'text', true, { max: 256 }),
      bool('pinned'),
      c('status', 'enum', false, { values: ['open', 'achieved', 'closed'] }),
      c('carried_from_id', 'id', true),
      createdAt,
      deletedAt,
    ],
    {
      parents: [
        { column: 'space_id', table: 'space' },
        { column: 'carried_from_id', table: 'goal' },
      ],
    },
  ),
  table(
    'task',
    [
      c('space_id', 'id', false),
      c('project_id', 'id', true),
      c('title', 'text', false),
      c('note', 'text', false, { max: LONG_TEXT }),
      c('date', 'date', true),
      c('time', 'time', true),
      c('status', 'enum', false, { values: ['todo', 'done'] }),
      c('done_at', 'datetime', true, hidden),
      c('sort_order', 'real', false, hidden),
      bool('carried_over'),
      c('recurrence_id', 'id', true),
      c('series_index', 'int', true),
      c('goal_id', 'id', true),
      c('icon', 'text', true, { max: 256 }),
      bool('someday'),
      c('source', 'enum', false, { values: ['local', 'apple_reminders'] }),
      c('external_id', 'text', true, { max: 512 }),
      c('series_template', 'json', true, hidden),
      c('external_event_id', 'text', true, { max: 512 }),
      createdAt,
      deletedAt,
    ],
    {
      local: ['discarded'],
      parents: [
        { column: 'space_id', table: 'space' },
        { column: 'project_id', table: 'project' },
        { column: 'recurrence_id', table: 'recurrence' },
        { column: 'goal_id', table: 'goal' },
      ],
    },
  ),
  table(
    'routine',
    [
      c('space_id', 'id', false),
      c('title', 'text', false),
      c('icon', 'text', true, { max: 256 }),
      c('schedule_type', 'enum', false, { values: ['daily', 'weekdays', 'x_per_week', 'every_n_days', 'every_n_weeks'] }),
      c('weekdays', 'json', false),
      c('times_per_week', 'int', true),
      c('interval', 'int', true),
      c('start_date', 'date', false),
      c('time', 'time', true),
      bool('archived'),
      createdAt,
      deletedAt,
    ],
    { local: ['paused'], parents: [{ column: 'space_id', table: 'space' }] },
  ),
  table('routine_log', [c('routine_id', 'id', false), c('date', 'date', false), c('done_at', 'datetime', false, hidden), createdAt, deletedAt], {
    idKind: 'natural',
    parents: [{ column: 'routine_id', table: 'routine' }],
  }),
  table('routine_pause', [c('routine_id', 'id', false), c('from_date', 'date', false), c('to_date', 'date', true), createdAt, deletedAt], {
    parents: [{ column: 'routine_id', table: 'routine' }],
  }),
  table('reminder', [
    c('target_type', 'enum', false, { values: ['task', 'routine', 'event'] }),
    c('target_id', 'id', false),
    c('offset_min', 'int', false, { values: [0, 5, 15, 30, 60, 1440, 10080] }),
    c('fire_at', 'datetime', false, hidden),
    c('delivered', 'bool', false, hidden),
    createdAt,
    deletedAt,
  ]),
  table(
    'event',
    [
      c('space_id', 'id', false),
      c('title', 'text', false),
      c('start_date', 'date', false),
      c('start_time', 'time', true),
      c('end_date', 'date', false),
      c('end_time', 'time', true),
      bool('all_day'),
      c('kind', 'enum', false, { values: ['event', 'birthday', 'important'] }),
      c('repeat', 'enum', false, { values: ['once', 'monthly', 'yearly'] }),
      bool('important'),
      c('icon', 'text', true, { max: 256 }),
      c('birth_year', 'int', true),
      createdAt,
      deletedAt,
    ],
    { parents: [{ column: 'space_id', table: 'space' }] },
  ),
  table(
    'checklist',
    [c('space_id', 'id', false), c('title', 'text', false), c('date', 'date', true), bool('is_template'), c('icon', 'text', true, { max: 256 }), createdAt, deletedAt],
    { parents: [{ column: 'space_id', table: 'space' }] },
  ),
  table('checklist_item', [c('checklist_id', 'id', false), c('text', 'text', false), bool('checked'), c('sort_order', 'real', false, hidden), createdAt, deletedAt], {
    parents: [{ column: 'checklist_id', table: 'checklist' }],
  }),
  table(
    'focus_session',
    [
      c('task_id', 'id', true),
      c('space_id', 'id', false),
      c('planned_min', 'int', true),
      c('started_at', 'datetime', false),
      c('ended_at', 'datetime', true),
      c('paused_sec', 'int', false, hidden),
      c('paused_at', 'datetime', true, hidden),
      c('project_id', 'id', true),
      createdAt,
      deletedAt,
    ],
    { parents: [{ column: 'space_id', table: 'space' }] },
  ),
  table('calendar_account', [c('provider', 'enum', false, { values: ['google', 'icloud'] }), c('label', 'text', false, { max: 512 }), c('calendars', 'json', false), createdAt, deletedAt], {
    local: ['token_ref', 'username'],
  }),
  table(
    'holiday',
    [
      c('country', 'enum', false, { values: ['FR', 'TN'] }),
      c('year', 'int', false),
      c('key', 'text', false, { max: 64 }),
      c('date', 'date', false),
      c('name', 'text', false, { max: 256 }),
      c('kind', 'enum', false, { values: ['fixed', 'computed', 'lunar'] }),
      c('source', 'enum', false, { values: ['table', 'manual'] }),
      bool('overridden'),
      createdAt,
      deletedAt,
    ],
    { idKind: 'natural' },
  ),
  table('settings', [c('value', 'json', false)], { key: 'key', idKind: 'setting', purgeable: false }),
];

const BY_NAME: ReadonlyMap<string, SyncTable> = new Map(SYNC_TABLES.map((t) => [t.name, t]));
const COLUMNS: ReadonlyMap<string, ReadonlyMap<string, SyncColumn>> = new Map(SYNC_TABLES.map((t) => [t.name, new Map(t.columns.map((col) => [col.name, col]))]));

/** Table du catalogue pour un nom reçu (comparaison exacte), ou undefined. */
export function syncTable(name: string): SyncTable | undefined {
  return BY_NAME.get(name);
}

/** Colonne publiée d'une table du catalogue (comparaison exacte), ou undefined (colonne locale, technique ou inconnue). */
export function syncColumn(tableName: string, column: string): SyncColumn | undefined {
  return COLUMNS.get(tableName)?.get(column);
}

/** Tables du catalogue dont une colonne référence cette table (enfants), pour ne jamais purger un parent encore référencé. */
export function childRelations(name: string): readonly { readonly table: SyncTable; readonly column: string }[] {
  return SYNC_TABLES.flatMap((t) => t.parents.filter((p) => p.table === name).map((p) => ({ table: t, column: p.column })));
}

/** Rang topologique d'une table (départage à hlc égal, section 3.3). */
export function tableRank(name: string): number {
  const index = (SYNC_TABLE_ORDER as readonly string[]).indexOf(name);
  return index < 0 ? SYNC_TABLE_ORDER.length : index;
}

/** Colonnes publiées d'une table, dans l'ordre du catalogue. */
export function publishedColumns(t: SyncTable): readonly string[] {
  return t.columns.map((col) => col.name);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Réglages (section 8, audit M5)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Clés de réglage de portée `shared`, triées : les seules publiées (table `settings`). */
export const SHARED_SETTING_KEYS: readonly SettingKey[] = (Object.keys(SETTINGS_DEFINITIONS) as SettingKey[]).filter((key) => SETTINGS_DEFINITIONS[key].scope === 'shared').sort();

export type SettingKeyScope = 'shared' | 'local' | 'unknown';

export function settingKeyScope(key: string): SettingKeyScope {
  if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFINITIONS, key)) return 'unknown';
  return SETTINGS_DEFINITIONS[key as SettingKey].scope;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Espaces fixes (section 5.4) : jamais purgés ni tracés
// ---------------------------------------------------------------------------------------------------------------------------------

/** Identifiants fixes des espaces Pro et Perso (src/db/seed/defaultSpaces.ts, gravés dans la migration 0001). */
export const FIXED_SPACE_IDS: ReadonlySet<string> = new Set(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);

/** Une ligne de cette table et de cet identifiant peut-elle être purgée physiquement (section 5.4) ? */
export function isPurgeable(tableName: string, id: string): boolean {
  const t = syncTable(tableName);
  if (!t || !t.purgeable) return false;
  return !(t.name === 'space' && FIXED_SPACE_IDS.has(id));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Validation (section 3.3 : type et longueur)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Identifiant de ligne admis pour cette table : UUID, identifiant naturel de la table, ou clé de réglage. */
export function isValidRowId(t: SyncTable, id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SYNC_ID_LENGTH) return false;
  switch (t.idKind) {
    case 'uuid':
      return isId(id);
    case 'natural':
      return isNaturalId(t.name as NaturalIdTable, id) || isId(id);
    case 'setting':
      return /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/.test(id);
  }
}

/** La valeur respecte-t-elle le type et la longueur déclarés de la colonne ? */
export function isValidValue(col: SyncColumn, value: unknown): boolean {
  if (value === null) return col.nullable;
  switch (col.type) {
    case 'text':
      return typeof value === 'string' && value.length <= (col.max ?? SHORT_TEXT);
    case 'json':
      if (typeof value !== 'string' || value.length > (col.max ?? JSON_TEXT)) return false;
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value) && (col.values === undefined || col.values.includes(value));
    case 'real':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return value === 0 || value === 1;
    case 'date':
      return typeof value === 'string' && isLocalDate(value);
    case 'time':
      return typeof value === 'string' && isLocalTime(value);
    case 'datetime':
      return typeof value === 'string' && isIsoDateTime(value);
    case 'id':
      return typeof value === 'string' && value.length <= MAX_SYNC_ID_LENGTH && (isId(value) || isNaturalId('routine_log', value) || isNaturalId('holiday', value));
    case 'enum':
      return typeof value === 'string' && (col.values ?? []).includes(value);
  }
}
