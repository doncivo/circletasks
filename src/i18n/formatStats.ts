import type { MonthRef } from '../domain/monthReport';
import { getLocale, t } from './index';

const intlLocale = (): string => (getLocale() === 'fr' ? 'fr-FR' : 'en-US');

/** Nom du mois en lettres (« septembre »), selon la langue courante. */
export function formatMonthName(ref: MonthRef): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(ref.year, ref.month - 1, 1)));
}

/** En-tête du rapport : « septembre » pour l'année courante, « septembre 2025 » sinon (H-01 critère 2). */
export function formatReportMonth(ref: MonthRef, currentYear: number): string {
  const name = formatMonthName(ref);
  return ref.year === currentYear ? name : `${name} ${String(ref.year)}`;
}

/** Plage d'une semaine pour la bulle du graphique : « 31 août – 6 sept. ». */
export function formatWeekRange(from: string, to: string): string {
  const format = new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const utc = (iso: string): Date => {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  };
  return `${format.format(utc(from))} – ${format.format(utc(to))}`;
}

/** Date en toutes lettres selon la langue courante (« 23 septembre 2026 »), pour le pied du rapport exporté. */
export function formatLongDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** « 71 % » ; « — » sans valeur. */
export function formatPercentLabel(percent: number | null): string {
  return percent === null ? t('stats.noValue') : `${String(percent)} %`;
}
