/**
 * Textes des états vides (P-06) : libellés d'action et messages qui n'existaient pas encore. Les phrases d'accroche déjà en place
 * (tasks.emptyToday, routines.empty, events.empty, checklists.empty, someday.empty, done.empty, trash.empty) restent dans leur module.
 */
export const emptyFr = {
  addTask: 'Ajouter une tâche',
  openSomeday: 'Ouvrir « Un jour » · {count} tâches',
  openSomedayOne: 'Ouvrir « Un jour » · 1 tâche',
  weekTitle: 'Rien de prévu cette semaine.',
  weekTitleSpace: 'Aucune tâche {space} cette semaine.',
  createRoutine: 'Créer une routine',
  addEvent: 'Ajouter un événement',
  createChecklist: 'Créer une checklist',
  addSomeday: 'Ajouter à « Un jour »',
  goToToday: 'Aller à Aujourd’hui',
  openRoutines: 'Voir les routines',
} as const;
