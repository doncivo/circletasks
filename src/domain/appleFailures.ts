/**
 * Codes d'échec d'un passage des Rappels Apple et gestes utiles (revue : aucune impasse). Tout code posé dans l'état persistant a un texte français
 * et anglais (`appleReminders.failureCode.<code>`) et au moins un geste à l'écran Agendas : `retry` (« Réessayer »), `ios-settings` (le texte
 * indique Réglages d'iOS), `choose-lists` (« Choisir les listes »), `detach-unlisted` (« Détacher les tâches de ces listes »),
 * `reset-lists` (« Réinitialiser le réglage des listes »), `reopen-app` (le texte demande de rouvrir l'app).
 */
export type AppleFailureAction = 'retry' | 'ios-settings' | 'choose-lists' | 'detach-unlisted' | 'reset-lists' | 'reopen-app';

export const APPLE_FAILURE_ACTIONS = {
  'access-denied': ['ios-settings', 'retry'],
  'store-unavailable': ['retry'],
  'read-failed': ['retry'],
  'write-failed': ['retry'],
  'not-found': ['retry'],
  'list-not-found': ['choose-lists', 'retry'],
  'read-only-list': ['choose-lists'],
  'recurring-refused': ['retry'],
  'invalid-input': ['retry'],
  'pass-failed': ['retry'],
  'settings-unreadable': ['reset-lists', 'retry'],
  'lists-setting-invalid': ['choose-lists', 'detach-unlisted', 'reset-lists'],
  'start-load-failed': ['reopen-app'],
} as const satisfies Record<string, readonly AppleFailureAction[]>;

export type AppleFailureCode = keyof typeof APPLE_FAILURE_ACTIONS;
export const APPLE_FAILURE_CODES = Object.keys(APPLE_FAILURE_ACTIONS) as AppleFailureCode[];

export const isKnownFailure = (code: string): code is AppleFailureCode => Object.prototype.hasOwnProperty.call(APPLE_FAILURE_ACTIONS, code);

/** Gestes d'un code ; un code inconnu (version plus récente) propose au moins de réessayer. */
export function failureActions(code: string): readonly AppleFailureAction[] {
  return isKnownFailure(code) ? APPLE_FAILURE_ACTIONS[code] : ['retry'];
}
