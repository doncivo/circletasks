import { getLocale } from './index';

const fr = {
  more: "Plus d'options",
  moreHint: 'répétition, rappel, projet, icône',
  date: 'Date',
  time: 'Heure',
  noTime: "Pas d'heure",
  planned: 'Prévue',
  reminder: 'Rappels',
  quiet: 'Décalé par la plage silencieuse de {space}',
  inactive: 'Rappels conservés, inactifs',
  defineGoal: 'En définir un',
  noNote: 'Aucune note',
  scheduleDone: 'Terminé',
} as const;
const en: Record<keyof typeof fr, string> = {
  more: 'More options', moreHint: 'repeat, reminder, project, icon', date: 'Date', time: 'Time', noTime: 'No time', planned: 'Scheduled', reminder: 'Reminders', quiet: 'Moved by quiet hours for {space}', inactive: 'Reminders kept, inactive', defineGoal: 'Set a goal', noNote: 'No note', scheduleDone: 'Done',
};

/** Ce catalogue ne se charge qu'avec les feuilles de tâches. */
export function tTaskRefonte(key: keyof typeof fr, params?: { space: string }): string {
  const text = (getLocale() === 'en' ? en : fr)[key];
  return params ? text.replace('{space}', params.space) : text;
}
