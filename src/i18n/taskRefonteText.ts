import { getLocale } from './index';

const fr = {
  more: "Plus d'options",
  moreHint: 'répétition, rappel, projet, icône',
  add: 'Ajouter la tâche',
  date: 'Date',
  time: 'Heure',
  noTime: "Pas d'heure",
  planned: 'Prévue',
  reminder: 'Rappels',
  quiet: 'Décalé par la plage silencieuse de {space}',
  inactive: 'Inactif : tâche terminée ou sans date et heure',
  defineGoal: 'En définir un',
  noNote: 'Aucune note',
} as const;
const en: Record<keyof typeof fr, string> = {
  more: 'More options', moreHint: 'repeat, reminder, project, icon', add: 'Add task', date: 'Date', time: 'Time', noTime: 'No time', planned: 'Scheduled', reminder: 'Reminders', quiet: 'Moved by quiet hours for {space}', inactive: 'Inactive: completed task or no date and time', defineGoal: 'Set a goal', noNote: 'No note',
};

/** Ce catalogue ne se charge qu'avec les feuilles de tâches. */
export function tTaskRefonte(key: keyof typeof fr, params?: { space: string }): string {
  const text = (getLocale() === 'en' ? en : fr)[key];
  return params ? text.replace('{space}', params.space) : text;
}
