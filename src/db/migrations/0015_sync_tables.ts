import type { Migration } from '../migrator';

/**
 * Tables de la synchronisation et déclencheurs de capture (ADR 0011, sections 3.2, 3.4, 4.3, 5.4, 7.2 et 8 ; Y-02, Y-05, Y-09).
 *
 * Toutes les tables créées ici sont **locales** (jamais publiées) :
 * - `sync_guard` : garde posée dans une transaction par la synchro, les migrations et la purge ; tant qu'elle contient une ligne, les
 *   déclencheurs de capture ne s'exécutent pas (invariants de l'audit M10 : posée et retirée dans la même transaction) ;
 * - `sync_field_clock` : horloge (hlc) et base de chaque champ modifié ; entrée `'*'` = repli des champs sans entrée propre, toujours
 *   présente dès qu'une ligne a une horloge de champ (écrite au premier changement du hlc de la ligne s'il manque) ;
 * - `sync_outbox` : file d'envoi (Y-05), une entrée par (table, ligne, champ) ; une suppression suivie d’une insertion lui donne un nouveau numéro à chaque
 *   écriture, de sorte qu'une écriture faite pendant une publication n'est jamais retirée avec elle ;
 * - `sync_state` : une ligne par appareil (curseur, tête, accusés, anti-rejeu, statut) ;
 * - `sync_tombstone` : identifiants purgés, sans contenu, gardés sans limite (Y-09) ;
 * - `sync_unknown` : champs d'une version plus récente (Y-07) ;
 * - `sync_parked` : opérations mises de côté (parent manquant, report au changement d'époque) ;
 * - `conflict_log` : valeurs écartées par la fusion (Y-04) ;
 * - `sync_meta` : état local du moteur (époque courante, tête publiée, étape d'un changement d'époque).
 *
 * Les déclencheurs sont générés depuis une **copie figée** du catalogue (`CAPTURE_TABLES_V15`) : une migration publiée ne change plus
 * (somme de contrôle). `syncCatalogue.test.ts` vérifie que cette copie est égale au catalogue `src/domain/sync/syncTables.ts` ; toute
 * colonne publiée ajoutée plus tard passe par une nouvelle migration qui recrée les déclencheurs. Aucune colonne locale (`task.discarded`,
 * `routine.paused`, `calendar_account.token_ref`, `calendar_account.username`) n'y figure : elles n'entrent jamais dans la file.
 */

/** Copie figée (version 15) des colonnes publiées par table : [table, clé primaire, colonnes]. */
export const CAPTURE_TABLES_V15: readonly (readonly [table: string, key: 'id' | 'key', columns: readonly string[]])[] = [
  ['space', 'id', ['name', 'color', 'sort_order', 'quiet_hours', 'created_at', 'deleted_at']],
  ['project', 'id', ['space_id', 'name', 'color', 'archived', 'sort_order', 'created_at', 'deleted_at']],
  ['recurrence', 'id', ['freq', 'interval', 'weekdays', 'month_day', 'nth_weekday', 'until', 'count', 'created_at', 'deleted_at']],
  ['goal', 'id', ['space_id', 'week_start', 'title', 'icon', 'pinned', 'status', 'carried_from_id', 'created_at', 'deleted_at']],
  [
    'task',
    'id',
    [
      'space_id',
      'project_id',
      'title',
      'note',
      'date',
      'time',
      'status',
      'done_at',
      'sort_order',
      'carried_over',
      'recurrence_id',
      'series_index',
      'goal_id',
      'icon',
      'someday',
      'source',
      'external_id',
      'series_template',
      'external_event_id',
      'created_at',
      'deleted_at',
    ],
  ],
  ['routine', 'id', ['space_id', 'title', 'icon', 'schedule_type', 'weekdays', 'times_per_week', 'interval', 'start_date', 'time', 'archived', 'created_at', 'deleted_at']],
  ['routine_log', 'id', ['routine_id', 'date', 'done_at', 'created_at', 'deleted_at']],
  ['routine_pause', 'id', ['routine_id', 'from_date', 'to_date', 'created_at', 'deleted_at']],
  ['reminder', 'id', ['target_type', 'target_id', 'offset_min', 'fire_at', 'delivered', 'created_at', 'deleted_at']],
  ['event', 'id', ['space_id', 'title', 'start_date', 'start_time', 'end_date', 'end_time', 'all_day', 'kind', 'repeat', 'important', 'icon', 'birth_year', 'created_at', 'deleted_at']],
  ['checklist', 'id', ['space_id', 'title', 'date', 'is_template', 'icon', 'created_at', 'deleted_at']],
  ['checklist_item', 'id', ['checklist_id', 'text', 'checked', 'sort_order', 'created_at', 'deleted_at']],
  ['focus_session', 'id', ['task_id', 'space_id', 'planned_min', 'started_at', 'ended_at', 'paused_sec', 'paused_at', 'project_id', 'created_at', 'deleted_at']],
  ['calendar_account', 'id', ['provider', 'label', 'calendars', 'created_at', 'deleted_at']],
  ['holiday', 'id', ['country', 'year', 'key', 'date', 'name', 'kind', 'source', 'overridden', 'created_at', 'deleted_at']],
  ['settings', 'key', ['value']],
];

/** Copie figée (version 15) des clés de réglage de portée `shared` : les seules capturées dans `settings`. */
export const SHARED_SETTING_KEYS_V15: readonly string[] = [
  'general.firstWeekday',
  'general.locale',
  'general.theme',
  'general.timeFormat',
  'holidays.countries',
  'reminders.defaultOffsets',
  'reminders.eveningRecap',
  'reminders.morningRecap',
  'spaces.defaultSpaceId',
  'tasks.carryOverUndone',
  'today.hideRoutines',
];

const UNGUARDED = 'NOT EXISTS (SELECT 1 FROM sync_guard)';

/** Déclencheurs d'une table : insertion (`'*'`) et modification (une entrée par colonne publiée qui change). */
function captureTriggers(table: string, key: string, columns: readonly string[]): string[] {
  const shared = table === 'settings' ? ` AND NEW.key IN (${SHARED_SETTING_KEYS_V15.map((k) => `'${k}'`).join(', ')})` : '';
  const row = `table_name = '${table}' AND row_id = NEW.${key}`;
  const fieldClock = (field: string): string => `(SELECT hlc FROM sync_field_clock WHERE ${row} AND field = '${field}')`;
  const perColumn = columns.flatMap((column) => [
    `INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT '${table}', NEW.${key}, '${column}', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE ${row} AND field IN ('${column}', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE ${row} AND field = '${column}')
           ELSE COALESCE(${fieldClock(column)}, ${fieldClock('*')}, OLD.hlc) END
       WHERE OLD.${column} IS NOT NEW.${column}
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;`,
    `DELETE FROM sync_outbox WHERE ${row} AND field = '${column}' AND OLD.${column} IS NOT NEW.${column};`,
    `INSERT INTO sync_outbox (table_name, row_id, field) SELECT '${table}', NEW.${key}, '${column}' WHERE OLD.${column} IS NOT NEW.${column};`,
  ]);
  // Restauration (deleted_at non nul → nul) : la ligne entière repart (entrée « + »), car un autre appareil a pu la purger entre-temps
  // (Y-09, restauration hors ligne contre purge) ; il ne peut la recréer qu'avec toutes ses colonnes.
  const restore = columns.includes('deleted_at')
    ? [
        `DELETE FROM sync_outbox WHERE ${row} AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
        `INSERT INTO sync_outbox (table_name, row_id, field) SELECT '${table}', NEW.${key}, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
        // Cible de rappels (tâche, routine, événement) : ses rappels vivants repartent aussi entiers, car un appareil qui a purgé la
        // cible les a purgés avec elle (T-08) ; ceux restaurés avec elle reçoivent leur propre « + » par le déclencheur de `reminder`.
        ...(['task', 'routine', 'event'].includes(table)
          ? [
              `INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = '${table}' AND r.target_id = NEW.${key} AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
            ]
          : []),
      ]
    : [];
  return [
    // Recréation locale d'un identifiant purgé (jour de routine recoché) : sa propre trace est retirée dans la même transaction.
    `CREATE TRIGGER sync_${table}_ai AFTER INSERT ON ${table} WHEN ${UNGUARDED}${shared} BEGIN
       DELETE FROM sync_tombstone WHERE ${row};
       DELETE FROM sync_outbox WHERE ${row} AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('${table}', NEW.${key}, '*');
     END`,
    `CREATE TRIGGER sync_${table}_au AFTER UPDATE ON ${table} WHEN ${UNGUARDED}${shared} BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT '${table}', NEW.${key}, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE ${row} AND field = '*');
       ${[...perColumn, ...restore].join('\n       ')}
     END`,
  ];
}

export const migration0015SyncTables: Migration = {
  version: 15,
  name: 'sync_tables',
  statements: [
    'CREATE TABLE sync_guard (id INTEGER PRIMARY KEY)',
    `CREATE TABLE sync_field_clock (
      table_name TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      field      TEXT NOT NULL,
      hlc        TEXT NOT NULL,
      base_hlc   TEXT,
      PRIMARY KEY (table_name, row_id, field)
    )`,
    'CREATE INDEX idx_sync_field_clock_hlc ON sync_field_clock(hlc)',
    `CREATE TABLE sync_outbox (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      field      TEXT NOT NULL,
      UNIQUE (table_name, row_id, field)
    )`,
    `CREATE TABLE sync_state (
      device_id      TEXT PRIMARY KEY,
      is_self        INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
      platform       TEXT,
      app_version    TEXT,
      epoch          TEXT,
      cursor_segment INTEGER NOT NULL DEFAULT 0,
      cursor_record  INTEGER NOT NULL DEFAULT 0,
      ack_hlc        TEXT,
      head_segment   INTEGER NOT NULL DEFAULT 0,
      head_record    INTEGER NOT NULL DEFAULT 0,
      head_hlc       TEXT,
      state_epoch    TEXT,
      state_seq      INTEGER NOT NULL DEFAULT 0,
      state_digest   TEXT,
      last_acks      TEXT NOT NULL DEFAULT '{}',
      last_seen_hlc  TEXT,
      last_sync_at   TEXT,
      schema_version INTEGER,
      format_major   INTEGER,
      kid            TEXT,
      purge_horizon  TEXT,
      snapshot_seq   INTEGER,
      snapshot_hlc   TEXT,
      status         TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'newer-major', 'clock-ahead', 'corrupt', 'foreign', 'rollback', 'forgotten'))
    )`,
    `CREATE TABLE sync_tombstone (
      table_name  TEXT NOT NULL,
      row_id      TEXT NOT NULL,
      deleted_hlc TEXT NOT NULL,
      purged_at   TEXT NOT NULL,
      PRIMARY KEY (table_name, row_id)
    )`,
    'CREATE INDEX idx_sync_tombstone_hlc ON sync_tombstone(deleted_hlc)',
    `CREATE TABLE sync_unknown (
      table_name TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      field      TEXT NOT NULL,
      value      TEXT,
      hlc        TEXT NOT NULL,
      base_hlc   TEXT,
      sv         INTEGER NOT NULL,
      PRIMARY KEY (table_name, row_id, field)
    )`,
    `CREATE TABLE sync_parked (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      reason     TEXT NOT NULL CHECK (reason IN ('missing-parent', 'missing-row', 'epoch-carry')),
      table_name TEXT NOT NULL,
      row_id     TEXT NOT NULL,
      hlc        TEXT NOT NULL,
      op         TEXT NOT NULL,
      parked_at  TEXT NOT NULL
    )`,
    'CREATE INDEX idx_sync_parked_reason ON sync_parked(reason, id)',
    'CREATE INDEX idx_sync_parked_row ON sync_parked(reason, table_name, row_id)',
    `CREATE TABLE conflict_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name       TEXT NOT NULL,
      row_id           TEXT NOT NULL,
      field            TEXT NOT NULL,
      kept_value       TEXT,
      discarded_value  TEXT,
      kept_device      TEXT,
      discarded_device TEXT,
      kept_hlc         TEXT,
      discarded_hlc    TEXT,
      detected_at      TEXT NOT NULL,
      resolved_at      TEXT,
      restored         INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0, 1))
    )`,
    'CREATE INDEX idx_conflict_log_detected_at ON conflict_log(detected_at)',
    'CREATE INDEX idx_conflict_log_row ON conflict_log(table_name, row_id, field)',
    'CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ...CAPTURE_TABLES_V15.flatMap(([table, key, columns]) => captureTriggers(table, key, columns)),
  ],
};
