import type { LocalDate, Weekday } from './types';

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Date civile `days` jours après (ou avant, si négatif) `date` : arithmétique pure en UTC, sans fuseau. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` as LocalDate;
}

/** Composantes d'une date civile 'YYYY-MM-DD' (mois 1–12). */
export function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** Construit une date civile ; le jour doit exister dans le mois (voir `daysInMonth`). */
export function makeLocalDate(year: number, month: number, day: number): LocalDate {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}` as LocalDate;
}

/** Nombre de jours du mois (month 1–12), années bissextiles comprises. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Jour de semaine ISO de la date : 1 = lundi … 7 = dimanche. */
export function weekdayOf(date: LocalDate): Weekday {
  const { year, month, day } = parseLocalDate(date);
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (js === 0 ? 7 : js) as Weekday;
}
