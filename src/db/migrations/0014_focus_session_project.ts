import type { Migration } from '../migrator';

/**
 * Revue F-01 à F-04 : `focus_session.project_id`, projet de la tâche FIGÉ au lancement (ES-08 critère 2). Les totaux par projet lisent
 * cette colonne : ils ne dépendent plus de la ligne `task` (corbeille purgée, tâche déplacée ensuite). Sans clé étrangère (comme
 * `task_id`). Les sessions existantes reprennent le projet actuel de leur tâche. Rejouable : le migrateur n'applique qu'une fois chaque version
 * (journal schema_migrations, voir migrator.ts) ; le remplissage ne touche que les lignes encore nulles.
 */
export const migration0014FocusSessionProject: Migration = {
  version: 14,
  name: 'focus_session_project',
  statements: [
    'ALTER TABLE focus_session ADD COLUMN project_id TEXT',
    'UPDATE focus_session SET project_id = (SELECT project_id FROM task WHERE task.id = focus_session.task_id) WHERE project_id IS NULL AND task_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_focus_session_project_id ON focus_session(project_id) WHERE project_id IS NOT NULL',
  ],
};
