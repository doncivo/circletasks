import type { Migration } from '../migrator';

/**
 * T-12 : une copie annulée (« Annuler » après « Dupliquer ») est supprimée logiquement (le tombstone reste
 * pour la synchro) mais n'a rien à restaurer : `discarded = 1` l'exclut de la corbeille. Colonne locale au
 * repository (absente de l'entité `Task`), 0 pour toute autre tâche.
 */
export const migration0004TaskDiscarded: Migration = {
  version: 4,
  name: 'task_discarded',
  statements: ['ALTER TABLE task ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0'],
};
