import type { Migration } from '../migrator';

/**
 * T-10 : « cette occurrence ». Une occurrence modifiée seule garde, en JSON, les valeurs de la
 * série (titre, note, icône, heure, espace, projet, date prévue) : l'occurrence suivante est
 * générée avec elles. NULL pour toute autre tâche. Colonne ordinaire pour la synchro (ordre 4).
 */
export const migration0003TaskSeriesTemplate: Migration = {
  version: 3,
  name: 'task_series_template',
  statements: ['ALTER TABLE task ADD COLUMN series_template TEXT'],
};
