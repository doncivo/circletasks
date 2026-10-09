/**
 * Noms des écrans à la demande (`lazyScreens.tsx`) et préfixe du repère posé sur <html> quand le bloc d'un écran est arrivé ou a
 * échoué. Module sans dépendance : les aides e2e l'importent sans tirer React ni les feuilles de style.
 */
export const SCREEN_LOADED_PREFIX = 'data-ct-loaded-';

export type ScreenName =
  | 'reportscreen'
  | 'donetasksscreen'
  | 'trashscreen'
  | 'taskdetail'
  | 'somedayscreen'
  | 'goalsscreen'
  | 'weekscreen'
  | 'routinesscreen'
  | 'eventsscreen'
  | 'checklistsscreen'
  | 'settingsscreen'
  | 'appearancescreen'
  | 'tabsscreen'
  | 'importscreen'
  | 'logsscreen'
  | 'recoveryfailure'
  | 'updaterestoreaction'
  | 'recapsettingsscreen'
  | 'holidaysettingsscreen'
  | 'spacesscreen'
  | 'calendarsscreen'
  | 'syncdetailsscreen'
  | 'quiethoursroute';
