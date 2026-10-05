/**
 * Textes de `sync.version` (Y-07), en français : source de vérité. Bandeau A-09 « Mettez à jour l'app », emplacement « version » de
 * Réglages › Synchronisation › Détails et échec de réintégration (exigence d'Ali). Jamais de numéro de migration : seul le numéro
 * d'application publié par l'autre appareil (D2) ; jamais de valeur reçue ni de message d'erreur.
 */
export const syncVersionFr = {
  banner: 'Mettez à jour l’app : un de vos appareils utilise une version plus récente',
  section: 'VERSION',
  newer: '{device} utilise une version plus récente de l’app',
  newerWithVersion: '{device} utilise une version plus récente de l’app ({version})',
  readSuspended: 'Lecture de ses données suspendue : mettez à jour l’app',
  failedLineOne: '1 élément reçu d’une version plus récente n’a pas pu être intégré',
  failedLineMany: '{count} éléments reçus d’une version plus récente n’ont pas pu être intégrés',
  failedDetail: '{count} éléments non intégrés ({kinds})',
  failedDetailOne: '1 élément non intégré ({kinds})',
  failedLastTry: 'Dernier essai : {time}',
  failedRetry: 'L’app réessaie à chaque démarrage',
  failedBanner: 'Des éléments reçus n’ont pas pu être intégrés : voir Réglages › Synchronisation',
  kinds: {
    space: 'espaces',
    project: 'projets',
    recurrence: 'répétitions',
    goal: 'objectifs',
    task: 'tâches',
    routine: 'routines',
    routineLog: 'jours de routine',
    routinePause: 'pauses de routine',
    reminder: 'rappels',
    event: 'événements',
    checklist: 'checklists',
    checklistItem: 'éléments de checklist',
    focusSession: 'sessions Focus',
    calendarAccount: 'comptes d’agenda',
    holiday: 'jours fériés',
    settings: 'réglages',
    other: 'autres éléments',
  },
} as const;
