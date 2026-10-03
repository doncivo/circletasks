import type { Migration } from '../migrator';

/**
 * C-01 : icône d'une checklist (Checklists.html, PC-Checklists.html : une icône par checklist). Colonne `checklist.icon`
 * nullable au même format que `task.icon` (`lucide:<nom>` ou `emoji:<caractère>`) ; NULL = icône « liste » par défaut.
 * Les checklists existantes gardent NULL. Colonne ordinaire pour la synchro (ordre 4).
 */
export const migration0008ChecklistIcon: Migration = {
  version: 8,
  name: 'checklist_icon',
  statements: ['ALTER TABLE checklist ADD COLUMN icon TEXT'],
};
