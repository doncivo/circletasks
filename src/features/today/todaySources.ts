import type { ChecklistSummary } from '../../domain/model';
import type { TodayEventEntry, TodayGoalEntry, TodayRoutineEntry } from '../../domain/todayList';
import type { LocalDate, RoutineId, SpaceFilter } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Sources des éléments d'Aujourd'hui autres que les tâches (A-01, critères 3 et 4).
 *
 * Aujourd'hui assemble ce que chaque module lui fournit : les routines (M4), événements internes et externes
 * (M7, M8), checklists du jour (M6) et l'objectif épinglé (M17) n'existent pas encore, donc aucune source
 * n'est enregistrée et la liste n'affiche que des tâches, sans aucun élément simulé. Chaque module branche la
 * sienne à son arrivée avec `registerTodaySource` (par exemple au démarrage de l'app), sans toucher à l'écran :
 *   - routines : `{ routines: [{ routine, done }] }` (occurrences calculées par le domaine, R-02) ;
 *   - événements : `{ events: [...] }` (occurrences du jour, locaux et externes) ;
 *   - checklists : `{ checklists: [...] }` ; objectif : `{ goal }` (OB-02).
 * L'interface (lignes, bandeaux, section, carte) est déjà prête pour chacun de ces types.
 */
export interface TodayExtras {
  readonly routines: readonly TodayRoutineEntry[];
  readonly events: readonly TodayEventEntry[];
  readonly checklists: readonly ChecklistSummary[];
  readonly goal: TodayGoalEntry | null;
}

export const EMPTY_TODAY_EXTRAS: TodayExtras = { routines: [], events: [], checklists: [], goal: null };

export interface TodaySource {
  readonly id: string;
  /** Éléments du jour `date` pour le filtre d'espace ; peut rejeter (l'écran affiche alors un message et garde le reste). */
  load(container: AppContainer, date: LocalDate, filter: SpaceFilter): Promise<Partial<TodayExtras>>;
  /**
   * Valider (`done` vrai) ou rouvrir une routine depuis la liste (R-03) ; sans elle, la ligne n'a pas de case. L'état voulu est passé
   * explicitement (et non « basculer ») : un double clic ne valide jamais deux fois ni ne défait la validation.
   */
  toggleRoutine?(container: AppContainer, routineId: RoutineId, date: LocalDate, done: boolean): Promise<void>;
  /**
   * S'abonne aux changements des éléments de la source (ex. une validation annulée par « Annuler » ou Ctrl+Z, qui écrit en base sans
   * passer par l'écran) : l'écran se relit. Renvoie le désabonnement.
   */
  subscribe?(container: AppContainer, onChange: () => void): () => void;
}

const sources: TodaySource[] = [];

/** Enregistre une source ; renvoie la fonction qui la retire (tests, démontage). */
export function registerTodaySource(source: TodaySource): () => void {
  sources.push(source);
  return () => {
    const index = sources.indexOf(source);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** Abonne `onChange` aux changements de toutes les sources qui en signalent ; renvoie le désabonnement global. */
export function subscribeToTodaySources(container: AppContainer, onChange: () => void): () => void {
  const unsubscribes = sources.flatMap((source) => (source.subscribe ? [source.subscribe(container, onChange)] : []));
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Une source de routines sait-elle valider ? (affiche la case des routines) */
export function canToggleRoutines(): boolean {
  return sources.some((source) => source.toggleRoutine !== undefined);
}

export async function toggleRoutineViaSources(container: AppContainer, routineId: RoutineId, date: LocalDate, done: boolean): Promise<void> {
  const source = sources.find((candidate) => candidate.toggleRoutine !== undefined);
  await source?.toggleRoutine?.(container, routineId, date, done);
}

/** Fusionne les sources enregistrées ; `failed` : au moins une a échoué (les autres restent affichées). */
export async function loadTodayExtras(container: AppContainer, date: LocalDate, filter: SpaceFilter): Promise<{ extras: TodayExtras; failed: boolean }> {
  const results = await Promise.allSettled([...sources].map((source) => source.load(container, date, filter)));
  let extras = EMPTY_TODAY_EXTRAS;
  let failed = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      failed = true;
      continue;
    }
    const part = result.value;
    extras = {
      routines: [...extras.routines, ...(part.routines ?? [])],
      events: [...extras.events, ...(part.events ?? [])],
      checklists: [...extras.checklists, ...(part.checklists ?? [])],
      goal: extras.goal ?? part.goal ?? null,
    };
  }
  return { extras, failed };
}
