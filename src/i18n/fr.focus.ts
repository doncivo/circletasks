/**
 * Textes du Focus (M10, F-01 à F-04), en français : source de vérité ; `en.focus.ts` suit la même forme.
 */
export const focusFr = {
  // --- écran de session (Focus.html) ---
  screenLabel: 'Session Focus',
  windowTitle: 'Focus',
  heading: 'FOCUS TIME',
  closeLabel: 'Fermer Focus',
  metaTime: '{time} · ',
  taskGone: 'Tâche supprimée',
  remainingOn: 'restantes sur {min} min',
  elapsed: 'écoulées',
  announceRemaining: '{min} min restantes',
  announceElapsed: '{min} min écoulées',
  durationsLabel: 'Durée de la session',
  durationOption: '{min} min',
  durationFree: 'Libre',
  // --- pause (F-02) ---
  pause: 'Pause',
  pauseLabel: 'Mettre en pause',
  resume: 'Reprendre',
  resumeLabel: 'Reprendre la session',
  pausedSince: 'En pause depuis {time}',
  pausedState: 'Session en pause',
  runningState: 'Session reprise',
  stillPausedTitle: 'Toujours en pause ?',
  stillPausedStop: 'Arrêter',
  // --- arrêt volontaire (F-01) ---
  finishTask: 'Terminer la tâche',
  stopTitle: 'Arrêter la session ?',
  stopSave: 'Arrêter et enregistrer {min} min',
  stopDiscard: 'Arrêter sans enregistrer',
  stopDiscardHint: 'Moins d’une minute de concentration : la session ne sera pas enregistrée.',
  stopContinue: 'Continuer',
  alreadyRunning: 'Une session est déjà en cours',
  actionError: 'Action impossible sur la session Focus.',
  startError: 'Impossible de lancer la session Focus.',
  // --- fin de session (F-04) ---
  ended: 'Session terminée',
  endedWith: 'Session terminée · {duration}',
  another: 'Une autre session',
  dismiss: 'Fermer',
  // --- boutons de la fiche (A-08) ---
  launch: 'Lancer un Focus',
  launchPc: 'Focus {min} min',
  launchPcFree: 'Focus libre',
  // --- totaux (F-03) ---
  todayZero: 'Aujourd’hui : 0 min de concentration',
  today: 'Aujourd’hui : {duration} de concentration · {sessions}',
  sessionOne: '1 session',
  sessionMany: '{count} sessions',
  taskRow: 'Concentration',
  taskTotal: '{duration} · {sessions}',
  reportSection: 'CONCENTRATION',
  reportToday: 'Aujourd’hui',
  reportWeek: 'Cette semaine',
  reportMonth: 'Ce mois',
  reportTopTasks: 'Tâches les plus travaillées',
  reportTaskGone: 'Tâche supprimée',
  reportEmpty: 'Aucune session ce mois-ci.',
  // --- unités ---
  unitMinutes: '{min} min',
  unitHours: '{hours} h',
  unitHoursMinutes: '{hours} h {min}',
  // --- réglage (F-04) ---
  endSoundSetting: 'Son de fin de session',
} as const;
