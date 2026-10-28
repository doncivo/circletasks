import type { Routine } from '../domain/model';
import type { Weekday } from '../domain/types';
import { weekdayName } from './formatRoutine';
import { getLocale } from './index';

/**
 * Textes et formats propres à l'écran Routines iPhone (UI-REFONTE-05, Routines-v2.html) : chargés avec l'écran, hors du bundle de départ.
 * Synthèse de la semaine, fréquence en toutes lettres, bouton « Routine ».
 */
const fr = {
  summary: 'Semaine {span} · {counts}',
  summaryDone: '{done} sur {planned} faites',
  summaryDoneOne: '{done} sur {planned} faite',
  summaryNone: 'Aucune routine prévue cette semaine',
  spanSameMonth: 'du {from} au {to}',
  spanOtherMonth: 'du {from} au {to}',
  everyDay: 'tous les jours',
  weekdayRange: 'du {from} au {to}',
  listAnd: '{list} et {last}',
  timesPerWeek: '{count} fois par semaine',
  everyNDays: 'tous les {count} jours',
  everyNWeeksOn: 'toutes les {count} semaines, {days}',
  dayArticle: 'le {day}',
  addRoutine: 'Routine',
} as const;
const en: Record<keyof typeof fr, string> = {
  summary: 'Week {span} · {counts}',
  summaryDone: '{done} of {planned} done',
  summaryDoneOne: '{done} of {planned} done',
  summaryNone: 'No routine planned this week',
  spanSameMonth: 'of {from} to {to}',
  spanOtherMonth: 'of {from} to {to}',
  everyDay: 'every day',
  weekdayRange: '{from} to {to}',
  listAnd: '{list} and {last}',
  timesPerWeek: '{count} times a week',
  everyNDays: 'every {count} days',
  everyNWeeksOn: 'every {count} weeks on {days}',
  dayArticle: '{day}',
  addRoutine: 'Routine',
};

export function tRoutinesRefonte(key: keyof typeof fr, params: Record<string, string | number> = {}): string {
  let text: string = (getLocale() === 'en' ? en : fr)[key];
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
  return text;
}

const intlLocale = (): string => (getLocale() === 'fr' ? 'fr-FR' : 'en-US');
const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** « du 19 au 25 oct. » (même mois) ou « du 28 sept. au 4 oct. ». */
export function formatWeekSpan(from: string, to: string): string {
  const day = new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', timeZone: 'UTC' });
  const dayMonth = new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (from.slice(0, 7) === to.slice(0, 7)) return tRoutinesRefonte('spanSameMonth', { from: day.format(utcDate(from)), to: dayMonth.format(utcDate(to)) });
  return tRoutinesRefonte('spanOtherMonth', { from: dayMonth.format(utcDate(from)), to: dayMonth.format(utcDate(to)) });
}

/** « Semaine du 19 au 25 oct. · 7 sur 10 faites » ; « 1 sur 1 faite » ; aucune occurrence prévue : « Aucune routine prévue cette semaine ». */
export function formatRoutinesSummary(from: string, to: string, done: number, planned: number): string {
  if (planned === 0) return tRoutinesRefonte('summaryNone');
  const counts = tRoutinesRefonte(done === 1 ? 'summaryDoneOne' : 'summaryDone', { done, planned });
  return tRoutinesRefonte('summary', { span: formatWeekSpan(from, to), counts });
}

/** « lundi », « mardi »… en toutes lettres. */
const longDays = (weekdays: readonly Weekday[]): string[] => [...weekdays].sort((a, b) => a - b).map((day) => weekdayName(day, 'long'));

/** « lundi, mercredi et vendredi » ; un seul jour : « mardi ». */
function joinDays(days: readonly string[]): string {
  if (days.length <= 1) return days[0] ?? '';
  return tRoutinesRefonte('listAnd', { list: days.slice(0, -1).join(', '), last: days[days.length - 1] ?? '' });
}

/** Suite de jours consécutifs (au moins trois) : « du lundi au vendredi ». */
function consecutive(weekdays: readonly Weekday[]): boolean {
  const sorted = [...weekdays].sort((a, b) => a - b);
  return sorted.length >= 3 && sorted.every((day, index) => index === 0 || day === (sorted[index - 1] ?? 0) + 1);
}

type ScheduleFields = Pick<Routine, 'scheduleType' | 'weekdays' | 'timesPerWeek' | 'interval'>;

/**
 * Fréquence en toutes lettres pour la ligne d'informations de la carte iPhone (critère 3) : « tous les jours », « du lundi au vendredi »,
 * « lundi, mercredi et vendredi », « 3 fois par semaine », « tous les 3 jours », « toutes les 2 semaines, le mardi et le jeudi ».
 */
export function scheduleSentence(rule: ScheduleFields): string {
  switch (rule.scheduleType) {
    case 'daily':
      return tRoutinesRefonte('everyDay');
    case 'weekdays': {
      const days = longDays(rule.weekdays);
      if (consecutive(rule.weekdays)) return tRoutinesRefonte('weekdayRange', { from: days[0] ?? '', to: days[days.length - 1] ?? '' });
      return joinDays(days);
    }
    case 'x_per_week':
      return tRoutinesRefonte('timesPerWeek', { count: rule.timesPerWeek ?? 0 });
    case 'every_n_days':
      return tRoutinesRefonte('everyNDays', { count: rule.interval ?? 0 });
    case 'every_n_weeks':
      // « toutes les 2 semaines, le mardi et le jeudi » : article devant chaque jour en français.
      return tRoutinesRefonte('everyNWeeksOn', { count: rule.interval ?? 0, days: joinDays(longDays(rule.weekdays).map((day) => tRoutinesRefonte('dayArticle', { day }))) });
    default:
      return '';
  }
}
