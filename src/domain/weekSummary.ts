import type { LocalDate, LocalTime } from './types';
import type { WeekDay } from './week';

/**
 * Synthèse de la Semaine sur iPhone (UI-REFONTE-03, Semaine-v2.html) : « 8 tâches restantes · 6 faites · 1 en retard », comptée sur les
 * sept jours affichés et le filtre courant, tâches seulement (ni routines, ni événements, ni checklists). « En retard » : tâche non faite
 * d'un jour passé de la semaine affichée, ou du jour courant dont l'heure est dépassée (`now` null hors du jour courant : rien n'est dû).
 * Module à la demande, chargé avec l'écran Semaine.
 */
export interface WeekSummary {
  readonly remaining: number;
  readonly done: number;
  readonly late: number;
  readonly total: number;
}

export function weekSummary(days: readonly WeekDay[], today: LocalDate, now: LocalTime | null): WeekSummary {
  let remaining = 0;
  let done = 0;
  let late = 0;
  for (const day of days) {
    for (const row of day.list.rows) {
      if (row.kind !== 'task') continue;
      remaining += 1;
      if (day.date < today) late += 1;
      else if (day.date === today && now !== null && row.task.time !== null && row.task.time < now) late += 1;
    }
    for (const row of day.list.doneRows) if (row.kind === 'task') done += 1;
  }
  return { remaining, done, late, total: remaining + done };
}
