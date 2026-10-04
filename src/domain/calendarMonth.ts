import { addDays, daysInMonth, makeLocalDate } from './localDate';
import type { LocalDate } from './types';
import { daysSinceWeekStart, type FirstWeekday } from './week';

/**
 * Mini-calendrier du sélecteur de date PC (T-14) : grille d'un mois, semaine commençant le lundi
 * (L M M J V S D). Calcul en dates civiles, sans fuseau.
 */
export interface CalendarMonth {
  readonly year: number;
  /** 1 à 12. */
  readonly month: number;
}

/** Cases de la grille : `null` pour les cases vides avant le 1er (alignement lundi en premier). */
export function monthGrid(year: number, month: number, firstWeekday: FirstWeekday = 'monday'): readonly (LocalDate | null)[] {
  const first = makeLocalDate(year, month, 1);
  const leading = daysSinceWeekStart(first, firstWeekday);
  const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => makeLocalDate(year, month, i + 1));
  return [...Array.from({ length: leading }, () => null), ...days];
}

/** Mois décalé de `delta` mois (négatif : précédent). */
export function addMonths(current: CalendarMonth, delta: number): CalendarMonth {
  const total = current.year * 12 + (current.month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** Mois contenant `date`. */
export function monthOf(date: LocalDate): CalendarMonth {
  const [year, month] = date.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1 };
}

/** Déplacement clavier dans la grille (flèches : ±1 jour, ±7 jours ; Début / Fin : début / fin de semaine ; PageUp / PageDown : ±1 mois). */
export function moveCalendarFocus(date: LocalDate, key: string, firstWeekday: FirstWeekday = 'monday'): LocalDate | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(date, -1);
    case 'ArrowRight':
      return addDays(date, 1);
    case 'ArrowUp':
      return addDays(date, -7);
    case 'ArrowDown':
      return addDays(date, 7);
    case 'Home':
      return addDays(date, -daysSinceWeekStart(date, firstWeekday));
    case 'End':
      return addDays(date, 6 - daysSinceWeekStart(date, firstWeekday));
    case 'PageUp':
    case 'PageDown': {
      const [year, month, day] = date.split('-').map(Number);
      const next = addMonths({ year: year ?? 1970, month: month ?? 1 }, key === 'PageUp' ? -1 : 1);
      return makeLocalDate(next.year, next.month, Math.min(day ?? 1, daysInMonth(next.year, next.month)));
    }
    default:
      return null;
  }
}
