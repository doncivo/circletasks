import type { Routine } from '../domain/model';
import type { Weekday } from '../domain/types';
import { getLocale, t } from './index';

const intlLocale = (): string => (getLocale() === 'fr' ? 'fr-FR' : 'en-US');

/** Nom du jour de la semaine (1 = lundi) : « lun. » (court) ou « lundi » (long). */
export function weekdayName(weekday: Weekday, style: 'short' | 'long'): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, weekday))); // 1er janv. 2024 : lundi
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function weekdayList(weekdays: readonly Weekday[], style: 'short' | 'long'): string {
  return weekdays.map((day) => weekdayName(day, style)).join(', ');
}

type ScheduleFields = Pick<Routine, 'scheduleType' | 'weekdays' | 'timesPerWeek' | 'interval'>;

/**
 * Fréquence en bref, pour la ligne de la carte (« lun., mer., ven. », « 3 fois par semaine », « tous les 3 jours »). Vide pour
 * « Tous les jours » : la maquette n'ajoute rien dans ce cas.
 */
export function scheduleShort(rule: ScheduleFields): string {
  switch (rule.scheduleType) {
    case 'daily':
      return '';
    case 'weekdays':
      return weekdayList(rule.weekdays, 'short');
    case 'x_per_week':
      return t('routines.timesPerWeek', { count: rule.timesPerWeek ?? 0 });
    case 'every_n_days':
      return t('routines.everyNDays', { count: rule.interval ?? 0 });
    case 'every_n_weeks':
      return t('routines.everyNWeeksOn', { count: rule.interval ?? 0, days: weekdayList(rule.weekdays, 'short') });
    default:
      return '';
  }
}

/** Fréquence complète, pour le panneau de rapport (« Lundi, mercredi, vendredi », « Tous les jours »). */
export function scheduleLong(rule: ScheduleFields): string {
  switch (rule.scheduleType) {
    case 'daily':
      return capitalize(t('routines.everyDay'));
    case 'weekdays':
      return capitalize(weekdayList(rule.weekdays, 'long'));
    case 'x_per_week':
      return capitalize(t('routines.timesPerWeek', { count: rule.timesPerWeek ?? 0 }));
    case 'every_n_days':
      return capitalize(t('routines.everyNDays', { count: rule.interval ?? 0 }));
    case 'every_n_weeks':
      return capitalize(t('routines.everyNWeeksOn', { count: rule.interval ?? 0, days: weekdayList(rule.weekdays, 'long') }));
    default:
      return '';
  }
}

/**
 * Prochaines dates de « Tous les N » (R-07, ModifierRoutine-N.html) : « jeu. 24, dim. 27, mer. 30 sept., sam. 3 oct. » : le mois
 * n'est écrit qu'à la dernière date de chaque mois.
 */
export function formatNextOccurrences(dates: readonly string[]): string {
  const utc = (iso: string): Date => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  };
  const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' });
  const month = new Intl.DateTimeFormat(intlLocale(), { month: 'short', timeZone: 'UTC' });
  return dates
    .map((iso, index) => {
      const date = utc(iso);
      const next = dates[index + 1];
      const endsMonth = next === undefined || next.slice(0, 7) !== iso.slice(0, 7);
      return `${weekday.format(date)} ${String(date.getUTCDate())}${endsMonth ? ` ${month.format(date)}` : ''}`;
    })
    .join(', ');
}
