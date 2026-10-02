import { addDays } from './localDate';
import type { LocalDate, LocalTime } from './types';

/**
 * Choix des roues iPhone (T-14, Ajout.html) : jours (aujourd'hui en tête de lecture, jours passés et
 * futurs), heures « — » puis 00 à 23 (24 h), minutes par pas de 5. « — » = sans heure (Q9).
 */
export const WHEEL_MINUTE_STEP = 5;
/** Minutes proposées : 00, 05 … 55. */
export const WHEEL_MINUTES: readonly number[] = Array.from({ length: 60 / WHEEL_MINUTE_STEP }, (_, i) => i * WHEEL_MINUTE_STEP);
/** Heures proposées : 0 à 23 (la position « — » est ajoutée par l'interface en tête de roue). */
export const WHEEL_HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);
/** Jours proposés avant et après aujourd'hui. */
export const WHEEL_DAYS_BEFORE = 60;
export const WHEEL_DAYS_AFTER = 730;

/** Dates de la roue des jours, de `today - before` à `today + after` (aujourd'hui inclus, rang `before`). */
export function wheelDays(today: LocalDate, before = WHEEL_DAYS_BEFORE, after = WHEEL_DAYS_AFTER): readonly LocalDate[] {
  return Array.from({ length: before + after + 1 }, (_, i) => addDays(today, i - before));
}

/** Rang de `date` dans `wheelDays(today, before, after)` ; borné aux extrémités. */
export function wheelDayIndex(today: LocalDate, date: LocalDate, before = WHEEL_DAYS_BEFORE, after = WHEEL_DAYS_AFTER): number {
  const ms = (d: LocalDate): number => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1);
  };
  const diff = Math.round((ms(date) - ms(today)) / 86_400_000);
  return Math.min(Math.max(diff + before, 0), before + after);
}

/** Heure et minutes (au pas de 5, arrondies à la plus proche, 55 + arrondi → 55) d'une heure 'HH:mm' ; null sans heure. */
export function timeToWheel(time: LocalTime | null): { hour: number; minute: number } | null {
  if (time === null) return null;
  const [h, m] = time.split(':').map(Number);
  const minute = Math.min(Math.round((m ?? 0) / WHEEL_MINUTE_STEP) * WHEEL_MINUTE_STEP, 55);
  return { hour: h ?? 0, minute };
}

/** Heure 'HH:mm' des roues ; `hour` null (position « — ») : sans heure, les minutes sont ignorées. */
export function wheelToTime(hour: number | null, minute: number): LocalTime | null {
  if (hour === null) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` as LocalTime;
}
