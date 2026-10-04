import type { Migration } from '../migrator';

/**
 * K-04 : lien d'une tâche vers l'événement d'agenda externe dont elle vient (PRD section 6 : `task` → `external_event`, option).
 * `task.external_event_id` désigne la ligne `external_event` par son identifiant DÉTERMINISTE (compte, agenda, identifiant externe,
 * `externalEventRowId`), sans contrainte de clé étrangère : `external_event` est locale à chaque appareil et peut disparaître (événement
 * supprimé côté serveur, compte retiré) ; la tâche garde alors son titre et sa date, et sa fiche affiche « Événement supprimé ». La
 * colonne voyage avec la tâche dans les journaux de synchro. Pas d'index unique : deux appareils peuvent créer le lien en même temps
 * hors ligne, la synchro ne doit jamais échouer sur une contrainte (« une tâche par événement » est une règle de l'interface). Aucune
 * colonne `checklist_id` (C-03 D2). Numéro : premier libre du registre (0011 est pris par RC-01).
 */
export const migration0012TaskExternalEvent: Migration = {
  version: 12,
  name: 'task_external_event',
  statements: ['ALTER TABLE task ADD COLUMN external_event_id TEXT', 'CREATE INDEX idx_task_external_event_id ON task(external_event_id) WHERE external_event_id IS NOT NULL'],
};
