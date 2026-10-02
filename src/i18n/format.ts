import { getLocale } from './index';

/** Jour court lisible (« lun. 28 sept. »), selon la langue courante ; date civile, sans effet de fuseau. */
export function formatDayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

const MONTH_LABEL_OPTIONS = { month: 'long', year: 'numeric', timeZone: 'UTC' } as const;

function utcDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

/**
 * En-tête d'une période de tâches terminées (T-07), selon la langue courante :
 * « 23 sept. », « 21 – 27 sept. » (« 28 sept. – 4 oct. » à cheval sur deux mois), « septembre 2026 ».
 */
export function formatDonePeriodLabel(kind: 'day' | 'week' | 'month', from: string, to: string): string {
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const fmt = (options: Intl.DateTimeFormatOptions, date: string) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(utcDate(date));
  if (kind === 'month') return new Intl.DateTimeFormat(locale, MONTH_LABEL_OPTIONS).format(utcDate(from));
  if (kind === 'day') return fmt({ day: 'numeric', month: 'short' }, from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth
    ? `${fmt({ day: 'numeric' }, from)} – ${fmt({ day: 'numeric', month: 'short' }, to)}`
    : `${fmt({ day: 'numeric', month: 'short' }, from)} – ${fmt({ day: 'numeric', month: 'short' }, to)}`;
}
