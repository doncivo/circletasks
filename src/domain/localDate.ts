import type { LocalDate } from './types';

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Date civile `days` jours après (ou avant, si négatif) `date` : arithmétique pure en UTC, sans fuseau. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` as LocalDate;
}
