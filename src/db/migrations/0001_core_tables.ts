import type { Migration } from '../migrator';
import {
  SEED_AT,
  SEED_DEVICE_ID,
  SEED_HLC,
  SPACE_PERSO_COLOR,
  SPACE_PERSO_ID,
  SPACE_PERSO_NAME,
  SPACE_PRO_COLOR,
  SPACE_PRO_ID,
  SPACE_PRO_NAME,
} from '../seed/defaultSpaces';

/**
 * Schéma de l'ordre 1 (PRD section 6, ADR 0004) : les agrégats nécessaires aux
 * stories T, A, S, R, N (données), ES, OB, SD, D. Chaque table métier porte les
 * six colonnes de synchro (`id`, `created_at`, `updated_at`, `deleted_at`,
 * `device_id`, `hlc`), sauf `settings` (clé / valeur locale ou partagée, sans
 * identifiant ni suppression, conforme à PRD section 6).
 *
 * `event`, `checklist` et `checklist_item` sont des formes minimales (lecture
 * Aujourd'hui / Semaine) : elles seront complétées par une migration ultérieure
 * (checklists-events, ordre 2) sans modifier celle-ci.
 *
 * Pas de FTS5 ici (M14, ordre 2) : `search_index` arrive par la migration 0011.
 *
 * Pas de suppression physique dans ce code : les clés étrangères n'ont donc pas
 * besoin de `ON DELETE CASCADE` (la purge à 30 jours est un traitement de
 * synchro, ordre 4).
 */
export const migration0001CoreTables: Migration = {
  version: 1,
  name: 'core_tables',
  statements: [
    // --- space (ES-01, ES-07) ---------------------------------------------
    `CREATE TABLE space (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      sort_order  REAL NOT NULL,
      quiet_hours TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_space_deleted_at ON space(deleted_at)',
    'CREATE INDEX idx_space_hlc ON space(hlc)',

    // --- project (ES-04, ES-05) --------------------------------------------
    `CREATE TABLE project (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES space(id),
      name        TEXT NOT NULL,
      color       TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      sort_order  REAL NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_project_space_id ON project(space_id)',
    'CREATE INDEX idx_project_deleted_at ON project(deleted_at)',
    'CREATE INDEX idx_project_hlc ON project(hlc)',

    // --- recurrence (T-09, T-10) --------------------------------------------
    `CREATE TABLE recurrence (
      id           TEXT PRIMARY KEY,
      freq         TEXT NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly', 'yearly')),
      interval     INTEGER NOT NULL CHECK (interval >= 1),
      weekdays     TEXT NOT NULL DEFAULT '[]',
      month_day    INTEGER,
      nth_weekday  TEXT,
      until        TEXT,
      count        INTEGER,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT,
      device_id    TEXT NOT NULL,
      hlc          TEXT NOT NULL
    )`,
    'CREATE INDEX idx_recurrence_deleted_at ON recurrence(deleted_at)',
    'CREATE INDEX idx_recurrence_hlc ON recurrence(hlc)',

    // --- goal (M17) : avant task, qui la référence --------------------------
    `CREATE TABLE goal (
      id              TEXT PRIMARY KEY,
      space_id        TEXT NOT NULL REFERENCES space(id),
      week_start      TEXT NOT NULL,
      title           TEXT NOT NULL,
      icon            TEXT,
      pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'achieved', 'closed')),
      carried_from_id TEXT REFERENCES goal(id),
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT,
      device_id       TEXT NOT NULL,
      hlc             TEXT NOT NULL
    )`,
    'CREATE INDEX idx_goal_space_week ON goal(space_id, week_start)',
    'CREATE INDEX idx_goal_deleted_at ON goal(deleted_at)',
    'CREATE INDEX idx_goal_hlc ON goal(hlc)',

    // --- task (M1, M2, M3, M17, M18) -----------------------------------------
    `CREATE TABLE task (
      id            TEXT PRIMARY KEY,
      space_id      TEXT NOT NULL REFERENCES space(id),
      project_id    TEXT REFERENCES project(id),
      title         TEXT NOT NULL,
      note          TEXT NOT NULL DEFAULT '',
      date          TEXT,
      time          TEXT,
      status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'done')),
      done_at       TEXT,
      sort_order    REAL NOT NULL DEFAULT 0,
      carried_over  INTEGER NOT NULL DEFAULT 0 CHECK (carried_over IN (0, 1)),
      recurrence_id TEXT REFERENCES recurrence(id),
      series_index  INTEGER,
      goal_id       TEXT REFERENCES goal(id),
      icon          TEXT,
      someday       INTEGER NOT NULL DEFAULT 0 CHECK (someday IN (0, 1)),
      source        TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'apple_reminders')),
      external_id   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      deleted_at    TEXT,
      device_id     TEXT NOT NULL,
      hlc           TEXT NOT NULL
    )`,
    // A-01 (listForDay), S-01 (listForWeek) : la date est toujours filtrée, l'espace
    // parfois seulement (filtre « Tout ») ; la date en tête permet aux deux requêtes
    // d'utiliser l'index.
    'CREATE INDEX idx_task_date_space ON task(date, space_id)',
    // SD-01 : tâches Un jour.
    'CREATE INDEX idx_task_someday ON task(someday)',
    // T-07 : tâches terminées / à faire.
    'CREATE INDEX idx_task_status ON task(status)',
    'CREATE INDEX idx_task_deleted_at ON task(deleted_at)',
    'CREATE INDEX idx_task_hlc ON task(hlc)',
    'CREATE INDEX idx_task_recurrence_id ON task(recurrence_id)',
    'CREATE INDEX idx_task_goal_id ON task(goal_id)',

    // --- routine (M4) --------------------------------------------------------
    `CREATE TABLE routine (
      id             TEXT PRIMARY KEY,
      space_id       TEXT NOT NULL REFERENCES space(id),
      title          TEXT NOT NULL,
      icon           TEXT,
      schedule_type  TEXT NOT NULL CHECK (
        schedule_type IN ('daily', 'weekdays', 'x_per_week', 'every_n_days', 'every_n_weeks')
      ),
      weekdays       TEXT NOT NULL DEFAULT '[]',
      times_per_week INTEGER,
      interval       INTEGER,
      start_date     TEXT NOT NULL,
      time           TEXT,
      paused         INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT,
      device_id      TEXT NOT NULL,
      hlc            TEXT NOT NULL
    )`,
    'CREATE INDEX idx_routine_space_id ON routine(space_id)',
    'CREATE INDEX idx_routine_deleted_at ON routine(deleted_at)',
    'CREATE INDEX idx_routine_hlc ON routine(hlc)',

    // --- routine_log (R-03, R-04, R-06) : unique (routine_id, date) ---------
    `CREATE TABLE routine_log (
      id         TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routine(id),
      date       TEXT NOT NULL,
      done_at    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      device_id  TEXT NOT NULL,
      hlc        TEXT NOT NULL,
      UNIQUE (routine_id, date)
    )`,
    'CREATE INDEX idx_routine_log_deleted_at ON routine_log(deleted_at)',
    'CREATE INDEX idx_routine_log_hlc ON routine_log(hlc)',

    // --- reminder (M5, N-02) : cible polymorphe, pas de clé étrangère -------
    `CREATE TABLE reminder (
      id         TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('task', 'routine', 'event')),
      target_id   TEXT NOT NULL,
      offset_min  INTEGER NOT NULL CHECK (offset_min IN (0, 5, 15, 30, 60, 1440)),
      fire_at     TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_reminder_target ON reminder(target_type, target_id)',
    'CREATE INDEX idx_reminder_fire_at ON reminder(fire_at)',
    'CREATE INDEX idx_reminder_deleted_at ON reminder(deleted_at)',
    'CREATE INDEX idx_reminder_hlc ON reminder(hlc)',

    // --- event (M7, forme minimale ordre 1 pour A-01 / S-01) ----------------
    `CREATE TABLE event (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES space(id),
      title       TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      start_time  TEXT,
      end_date    TEXT NOT NULL,
      end_time    TEXT,
      all_day     INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
      kind        TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'birthday', 'important')),
      repeat      TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'monthly', 'yearly')),
      important   INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
      icon        TEXT,
      birth_year  INTEGER,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_event_space_start ON event(space_id, start_date)',
    'CREATE INDEX idx_event_deleted_at ON event(deleted_at)',
    'CREATE INDEX idx_event_hlc ON event(hlc)',

    // --- checklist / checklist_item (M6, forme minimale ordre 1) ------------
    `CREATE TABLE checklist (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL REFERENCES space(id),
      title       TEXT NOT NULL,
      date        TEXT,
      is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1)),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    'CREATE INDEX idx_checklist_space_date ON checklist(space_id, date)',
    'CREATE INDEX idx_checklist_deleted_at ON checklist(deleted_at)',
    'CREATE INDEX idx_checklist_hlc ON checklist(hlc)',

    `CREATE TABLE checklist_item (
      id           TEXT PRIMARY KEY,
      checklist_id TEXT NOT NULL REFERENCES checklist(id),
      text         TEXT NOT NULL,
      checked      INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
      sort_order   REAL NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      deleted_at   TEXT,
      device_id    TEXT NOT NULL,
      hlc          TEXT NOT NULL
    )`,
    'CREATE INDEX idx_checklist_item_checklist_id ON checklist_item(checklist_id)',
    'CREATE INDEX idx_checklist_item_deleted_at ON checklist_item(deleted_at)',
    'CREATE INDEX idx_checklist_item_hlc ON checklist_item(hlc)',

    // --- settings (clé / valeur, PRD section 6) -----------------------------
    // Pas de colonne id / created_at / deleted_at : une ligne par clé, jamais
    // supprimée (SettingsRepository n'expose pas de suppression). `updated_at`,
    // `device_id` et `hlc` restent posés par le WriteStamper à chaque écriture.
    `CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      hlc        TEXT NOT NULL
    )`,
    'CREATE INDEX idx_settings_hlc ON settings(hlc)',

    // --- données initiales : espaces Pro et Perso (ES-01) -------------------
    `INSERT INTO space (id, name, color, sort_order, quiet_hours, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES ('${SPACE_PRO_ID}', '${SPACE_PRO_NAME}', '${SPACE_PRO_COLOR}', 1, '[]', '${SEED_AT}', '${SEED_AT}', NULL, '${SEED_DEVICE_ID}', '${SEED_HLC}')`,
    `INSERT INTO space (id, name, color, sort_order, quiet_hours, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES ('${SPACE_PERSO_ID}', '${SPACE_PERSO_NAME}', '${SPACE_PERSO_COLOR}', 2, '[]', '${SEED_AT}', '${SEED_AT}', NULL, '${SEED_DEVICE_ID}', '${SEED_HLC}')`,
  ],
};
