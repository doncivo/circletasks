import { makeLocalDate } from '../localDate';
import type { LocalDate } from '../types';

/**
 * Dimanche de Pâques (calendrier grégorien) par l'algorithme de Meeus / Jones / Butcher : valable pour toute année grégorienne.
 * Les fêtes mobiles françaises en découlent (lundi de Pâques +1, Ascension +39, lundi de Pentecôte +50).
 */
export function easterSunday(year: number): LocalDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeLocalDate(year, month, day);
}
