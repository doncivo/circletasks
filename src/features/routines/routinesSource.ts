import { addDays } from '../../domain/localDate';
import { groupDoneDates, mondayOf, routinesForDay } from '../../domain/routineSchedule';
import { registerTodaySource, type TodaySource } from '../today/todaySources';
import { onRoutinesChanged } from './routineEvents';
import { createRoutineUseCases } from './routineUseCases';

/**
 * Source des routines d'Aujourd'hui et de la Semaine (A-01, S-01, R-01 critère 11) : lit les routines du filtre et les validations
 * de la semaine du jour (nécessaires au quota de « X fois par semaine », QB-01) ; le domaine (`routinesForDay`) calcule les
 * occurrences du jour, rien n'est stocké d'avance. `toggleRoutine` valide ou rouvre un jour (R-03) : annulable, une validation par jour.
 */
export const routinesTodaySource: TodaySource = {
  id: 'routines',
  async load(container, date, filter) {
    const weekStart = mondayOf(date);
    const [routines, logs] = await Promise.all([
      container.data.repos.routines.listForFilter(filter),
      container.data.repos.routineLogs.listForRange({ from: weekStart, to: addDays(weekStart, 6) }, filter),
    ]);
    return { routines: routinesForDay(routines, groupDoneDates(logs), date) };
  },
  async toggleRoutine(container, routineId, date, done) {
    await createRoutineUseCases(container).setDone(routineId, date, done);
  },
  subscribe: (container, onChange) => onRoutinesChanged(container.data, onChange),
};

let unregister: (() => void) | null = null;

/** Branche la source de routines sur Aujourd'hui et la Semaine, une seule fois (appelé au démarrage de l'app). */
export function registerRoutinesSource(): void {
  if (unregister) return;
  unregister = registerTodaySource(routinesTodaySource);
}

/** Retire la source (tests). */
export function unregisterRoutinesSource(): void {
  unregister?.();
  unregister = null;
}
