import { addDays } from '../../domain/localDate';
import { buildRecap, type Recap, type RecapKind } from '../../domain/recap';
import { mondayOf } from '../../domain/routineSchedule';
import type { LocalDate } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Lit les données du jour et calcule le contenu d'un récapitulatif (N-04), tous espaces confondus (filtre « Tout », indépendant de
 * l'espace affiché). Ordre 1 : le résultat n'est envoyé nulle part ; l'ordre 5 (N-05) le planifie sur l'iPhone uniquement.
 */
export async function loadRecap(container: Pick<AppContainer, 'data'>, kind: RecapKind, day: LocalDate): Promise<Recap> {
  const { repos } = container.data;
  const weekStart = mondayOf(day);
  const [tasks, routines, logs, pauses] = await Promise.all([
    repos.tasks.listForDay(day, 'all'),
    repos.routines.listForFilter('all'),
    // La semaine entière : le quota de « X fois par semaine » (QB-01) en dépend.
    repos.routineLogs.listForRange({ from: weekStart, to: addDays(weekStart, 6) }, 'all'),
    repos.routines.listPauses('all'),
  ]);
  return buildRecap(kind, day, tasks, routines, logs, pauses);
}
