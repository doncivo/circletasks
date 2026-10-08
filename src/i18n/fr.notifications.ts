/**
 * Textes des notifications de rappel (N-01, ADR 0012 avenant N1.3) et de l'état des rappels (Réglages > Rappels, bandeau), en français :
 * source de vérité ; `en.notifications.ts` suit la même forme. Le journal technique ne reçoit jamais ces textes (codes et nombres seulement).
 */
export const notificationsFr = {
  untitled: 'Sans titre',
  body: {
    atTime: 'À l’heure',
    inAdvance: 'Dans {advance}',
  },
  advance: {
    // Avances de N-02 : voir reminders.choice* ; « 1 semaine avant » n'existe que pour les événements (E-01).
    week: '1 semaine',
  },
  recap: {
    more: 'et {n} autres',
    morningTitle: 'Récapitulatif du matin',
    eveningTitle: 'Récapitulatif du soir',
    generic: 'Ouvrez CircleTasks pour voir votre journée',
  },
  focusEnd: {
    title: 'Session terminée · {duration}',
  },
} as const;

/** `reminders.status` : état des rappels (Réglages > Rappels, bandeau de l'app). */
export const remindersStatusFr = {
  sectionTitle: 'État des rappels',
  pcInfo: 'Les rappels sont envoyés par l’iPhone',
  neverPlanned: 'Aucune planification pour l’instant',
  allowExplain: 'CircleTasks envoie vos rappels et vos récapitulatifs par des notifications sur cet iPhone.',
  allow: 'Autoriser',
  allowLabel: 'Autoriser les notifications',
  allowButton: 'Autoriser les notifications',
  viewLabel: 'Voir le problème de rappels',
  troubleGeneric: 'Les rappels ne peuvent pas être envoyés',
  permissionDeniedBanner: 'Les notifications sont refusées : les rappels ne sonneront pas',
  permissionDenied: 'Les notifications sont refusées : les rappels ne sonneront pas. Autorisez-les dans Réglages > Notifications > CircleTasks sur l’iPhone.',
  permissionUndetermined: 'Autorisez les notifications pour recevoir vos rappels',
  unavailable: 'Les notifications ne sont pas disponibles sur cet iPhone',
  planFailed: 'Les rappels n’ont pas pu être planifiés',
  planFailedAt: 'Dernier essai à {time} · code {code}',
  planFailedPartial: '{scheduled} planifiés, {cancelled} annulés, {kept} conservés',
  focusEndFailed: 'La notification de fin de session n’a pas pu être planifiée',
  zoneUnknown: 'Fuseau de l’appareil illisible : rappels calculés avec le décalage actuel',
  zoneChanged: 'Fuseau modifié : rappels recalculés à {time}',
  ledgerRebuilt: 'Registre des rappels reconstruit à {time}',
  zoneLimit: 'Après un changement de fuseau, ouvrez CircleTasks : les rappels sont recalculés à l’ouverture.',
} as const;
