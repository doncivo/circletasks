import type { Migration } from '../migrator';

/**
 * T-07 : liste des tâches terminées par période (`TaskRepository.listDone`). L'index
 * porte sur (status, done_at) : égalité sur le statut puis plage d'instants,
 * la suppression et l'espace se filtrent sur les lignes retenues. Réutilisé par
 * les statistiques (H-01) qui lisent la même plage.
 */
export const migration0002TaskDoneAtIndex: Migration = {
  version: 2,
  name: 'task_done_at_index',
  statements: ['CREATE INDEX idx_task_status_done_at ON task(status, done_at)'],
};
