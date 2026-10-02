import { getLocale } from './index';

/** Jour court lisible (« lun. 28 sept. »), selon la langue courante ; date civile, sans effet de fuseau. */
export function formatDayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}
