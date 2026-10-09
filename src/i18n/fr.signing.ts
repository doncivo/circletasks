/**
 * Alerte avant l'expiration hebdomadaire de la signature SideStore (I-02, ADR 0013 §3). Textes neutres : SideStore peut actualiser
 * l'app sans l'ouvrir, la date lue peut donc devenir fausse avant que l'alerte ne sonne. Jamais un titre de tâche.
 */
export const signingFr = {
  alertTitle: 'CircleTasks va expirer',
  alertBody: 'Vérifiez dans SideStore que l’app a été actualisée (expiration prévue le {date} à {time})',
  /** Bandeau sous 24 h : durée restante composée par `durationHours` / `durationMinutes`. */
  bannerSoon: 'CircleTasks expire dans {duration} : actualisez-la dans SideStore',
  durationHours: '{n} h',
  durationMinutes: '{n} min',
  about: {
    /** « Expire le jeu. 15 oct. à 09:12 · dans 6 jours ». */
    expires: 'Expire le {date} à {time} · {remaining}',
    expired: 'Signature expirée depuis le {date} à {time}',
    remainingDays: 'dans {n} jours',
    remainingHours: 'dans {n} h',
    remainingMinutes: 'dans {n} min',
    alertAt: 'Alerte prévue le {date} à {time}',
    alertSoon: 'Moins de 24 h restantes : actualisez CircleTasks dans SideStore',
    unknown: 'Date d’expiration inconnue : l’alerte avant expiration est désactivée',
    unknownAt: 'Dernière lecture sans résultat à {time} ({code})',
    codeMissing: 'profil de signature absent',
    codeUnreadable: 'profil de signature illisible',
    notificationsDenied: 'Les notifications sont refusées : vous ne serez pas prévenu',
    notificationsUndetermined: 'Les notifications ne sont pas autorisées : vous ne serez pas prévenu',
    alertFailed: 'L’alerte n’a pas pu être planifiée : vous ne serez peut-être pas prévenu',
    allow: 'Autoriser',
    allowLabel: 'Autoriser les notifications pour l’alerte d’expiration',
    viewReminders: 'Voir',
    viewRemindersLabel: 'Voir les réglages des rappels pour autoriser les notifications',
    reading: 'Lecture de la date d’expiration…',
  },
} as const;
