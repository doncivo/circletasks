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
  // N-03 : boutons de la notification (titres passés au plugin, aucun texte en dur côté Swift).
  action: {
    done: 'Fait',
    snooze: '+15 min',
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
  planFailedAt: 'Dernier essai à {time} · {code}',
  planFailedPartial: '{scheduled} planifiés, {cancelled} annulés, {kept} conservés',
  focusEndFailed: 'La notification de fin de session n’a pas pu être planifiée',
  zoneUnknown: 'Fuseau de l’appareil illisible : rappels calculés avec le décalage actuel',
  zoneChanged: 'Fuseau modifié : rappels recalculés à {time}',
  ledgerRebuilt: 'Registre des rappels reconstruit à {time}',
  zoneLimit: 'Après un changement de fuseau, ouvrez CircleTasks : les rappels sont recalculés à l’ouverture.',
  // N-07 : avertissement du PC (le PC n'envoie aucune notification, il avertit seulement).
  warnStale: 'L’iPhone ne s’est pas synchronisé depuis plus de 2 h : ce rappel pourrait ne pas sonner à l’heure',
  warnNoIphone: 'Aucun iPhone associé : ce rappel ne sonnera pas',
  summaryStaleOne: 'L’iPhone ne s’est pas synchronisé depuis plus de 2 h : 1 rappel dans les 2 prochaines heures pourrait ne pas sonner à l’heure',
  summaryStaleMany: 'L’iPhone ne s’est pas synchronisé depuis plus de 2 h : {n} rappels dans les 2 prochaines heures pourraient ne pas sonner à l’heure',
  summaryNoIphoneOne: 'Aucun iPhone associé : 1 rappel dans les 2 prochaines heures ne sonnera pas',
  reason: {
    'duplicate-id': 'Identifiant en double',
    'over-limit': 'Plus de 64 notifications',
    'invalid-request': 'Notification invalide',
    'unavailable': 'Notifications indisponibles',
    'permission-denied': 'Autorisation refusée',
    'schedule-failed': 'Envoi refusé par iOS',
    'verify-failed': 'Notification absente après l’envoi',
    'ledger-failed': 'Registre non enregistré',
    'zone-unknown': 'Fuseau illisible',
  },
  // N-03 : actions « Fait » et « +15 min » des notifications.
  actionFailed: 'Une action de notification n’a pas pu être appliquée',
  actionsUnavailable: 'Les boutons « Fait » et « +15 min » des notifications ne sont pas disponibles',
  actionsTitle: 'Actions des notifications',
  actionsPending: 'Actions en attente d’application : {n} (nouvel essai à chaque ouverture)',
  actionsDropped: 'Actions écartées faute de place : {n}',
  actionsLost: 'Actions non enregistrées par iOS ou illisibles : {n}',
  actionsDismiss: 'Ignorer',
  actionsDismissLabel: 'Ignorer les actions de notification en échec',
  actionsReason: {
    'delegate-lost': 'Le plugin n’est plus le gestionnaire des notifications',
    'delegate-late': 'Le plugin est devenu gestionnaire après le lancement : une action reçue à froid a pu être perdue',
    'register-failed': 'Les boutons n’ont pas pu être enregistrés',
    'source-failed': 'Le fichier des actions n’a pas pu être lu',
    'queue-write-failed': 'Les actions reçues n’ont pas pu être enregistrées',
  },
  warnReadFailed: 'Les rappels proches n’ont pas pu être vérifiés : l’avertissement de synchro est indisponible',
  summaryNoIphoneMany: 'Aucun iPhone associé : {n} rappels dans les 2 prochaines heures ne sonneront pas',
} as const;
