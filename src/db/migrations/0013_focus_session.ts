import type { Migration } from '../migrator';

/**
 * F-01 : table `focus_session` (M10, PRD section 6 : task_id option, space_id, planned_min, started_at, ended_at, paused_sec + les
 * six colonnes de synchro), synchronisable. Écarts documentés (docs/stories/F-01.md D1) :
 * - `paused_at` (instant) ajouté au schéma du PRD : il porte la pause EN COURS, pour la reprendre après un redémarrage ; les pauses
 *   closes se cumulent dans `paused_sec` (F-02) ;
 * - `planned_min` est nul pour une session « Libre » ;
 * - `project_id` n'est pas stocké : le projet d'une session est celui de sa tâche (ES-08) ;
 * - `task_id` sans clé étrangère : la tâche peut être supprimée (corbeille purgée) sans toucher à la session, qui reste comptée
 *   (F-03 critère 8) ; la valeur n'est pas vidée en base, `projectOfFocusSession` retombe sur « aucun projet ».
 * Le temps affiché se calcule toujours depuis `started_at`, `paused_sec` et `paused_at` (jamais d'un compteur). Une seule session
 * ouverte (`ended_at` nul, non supprimée) à la fois : règle des cas d'usage, pas d'index unique (deux appareils hors ligne ne doivent
 * jamais faire échouer la synchro sur une contrainte). Rejouable (IF NOT EXISTS).
 */
export const migration0013FocusSession: Migration = {
  version: 13,
  name: 'focus_session',
  statements: [
    `CREATE TABLE IF NOT EXISTS focus_session (
      id          TEXT PRIMARY KEY,
      task_id     TEXT,
      space_id    TEXT NOT NULL REFERENCES space(id),
      planned_min INTEGER CHECK (planned_min IS NULL OR planned_min > 0),
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      paused_sec  INTEGER NOT NULL DEFAULT 0 CHECK (paused_sec >= 0),
      paused_at   TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    // F-03 : totaux par jour / semaine (plage de started_at) et par tâche.
    'CREATE INDEX IF NOT EXISTS idx_focus_session_started_at ON focus_session(started_at)',
    'CREATE INDEX IF NOT EXISTS idx_focus_session_task_id ON focus_session(task_id)',
    'CREATE INDEX IF NOT EXISTS idx_focus_session_open ON focus_session(ended_at) WHERE ended_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_focus_session_deleted_at ON focus_session(deleted_at)',
    'CREATE INDEX IF NOT EXISTS idx_focus_session_hlc ON focus_session(hlc)',
  ],
};
