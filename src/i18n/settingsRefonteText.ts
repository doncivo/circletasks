import { getLocale } from './index';

/**
 * Textes propres à la refonte de Réglages sur PC (UI-REFONTE-09, PC-Reglages.html) : chargés avec l'écran Réglages, hors du bundle de
 * départ. L'iPhone garde les textes de `fr.ts` (titres en capitales, « Thème · semaine · heure », « (automatique) »).
 */
const fr = {
  summaryLabel: 'Sections des réglages',
  sectionGeneral: 'Général',
  sectionTasks: 'Tâches',
  sectionReminders: 'Rappels',
  sectionSpaces: 'Espaces et agendas',
  sectionSync: 'Synchronisation',
  sectionData: 'Sauvegardes et données',
  sectionKeyboard: 'Clavier',
  sectionAbout: 'À propos',
  theme: 'Thème',
  firstWeekday: 'Début de semaine',
  timeFormat: 'Format de l’heure',
  timeZoneHint: 'Suit celui de Windows',
  tabsVisible: 'Onglets visibles',
  tabsCount: '{visible} sur {total}',
  launchHint: 'CircleTasks s’ouvre réduit dans la zone de notification',
  allShortcuts: 'Tous les raccourcis',
  quickCaptureTaken: '{keys} est utilisé par une autre application. Choisissez-en un autre.',
} as const;
const en: Record<keyof typeof fr, string> = {
  summaryLabel: 'Settings sections',
  sectionGeneral: 'General',
  sectionTasks: 'Tasks',
  sectionReminders: 'Reminders',
  sectionSpaces: 'Spaces and calendars',
  sectionSync: 'Sync',
  sectionData: 'Backups and data',
  sectionKeyboard: 'Keyboard',
  sectionAbout: 'About',
  theme: 'Theme',
  firstWeekday: 'Week starts on',
  timeFormat: 'Time format',
  timeZoneHint: 'Follows Windows',
  tabsVisible: 'Visible tabs',
  tabsCount: '{visible} of {total}',
  launchHint: 'CircleTasks opens minimized in the notification area',
  allShortcuts: 'All shortcuts',
  quickCaptureTaken: '{keys} is used by another application. Choose another one.',
};

export type SettingsRefonteKey = keyof typeof fr;

export function tSettingsRefonte(key: SettingsRefonteKey, params: Record<string, string> = {}): string {
  let text: string = (getLocale() === 'en' ? en : fr)[key];
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, value);
  return text;
}
