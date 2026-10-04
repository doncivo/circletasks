import { todayLocal } from '../../domain/clock';
import type { SearchResult } from '../../domain/search';
import { resultTarget, type ResultTarget } from '../../domain/searchTarget';
import type { ChecklistId, EventId, GoalId, LocalDate, RoutineId, TaskId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import { useNavigationStore, type DetailTarget, type Route } from '../app/navigation';

/**
 * - `opened` : la navigation est faite (la recherche peut se fermer) ;
 * - `missing` : l'élément a été supprimé entre-temps (« Cet élément n'existe plus », la recherche reste ouverte, critère 4) ;
 * - `failed` : la base n'a pas répondu.
 */
export type OpenOutcome = 'opened' | 'missing' | 'failed';

/** L'élément existe-t-il toujours (non supprimé) ? */
async function stillExists(container: Pick<AppContainer, 'data'>, result: SearchResult): Promise<boolean> {
  const { repos } = container.data;
  const { id } = result.hit;
  switch (result.hit.kind) {
    case 'task':
      return (await repos.tasks.getById(id as TaskId)) !== null;
    case 'checklist':
      return (await repos.checklists.getById(id as ChecklistId)) !== null;
    case 'event':
      return (await repos.events.getById(id as EventId)) !== null;
    case 'routine':
      return (await repos.routines.getById(id as RoutineId)) !== null;
    case 'goal':
      return (await repos.goals.getById(id as GoalId)) !== null;
  }
}

function routeOf(target: ResultTarget, today: LocalDate): Route | null {
  switch (target.tab) {
    case 'tasks':
      if (target.screen === 'goals') return { tab: 'tasks', screen: 'goals' };
      if (target.screen === 'someday') return { tab: 'tasks', screen: 'someday' };
      return target.date !== null && target.date !== today ? { tab: 'tasks', screen: 'today', date: target.date } : { tab: 'tasks', screen: 'today' };
    case 'checklists':
      return { tab: 'checklists', checklistId: target.checklistId as ChecklistId };
    case 'events':
      return { tab: 'events' };
    case 'routines':
      return { tab: 'routines', screen: 'list' };
    case null:
      return null;
  }
}

/**
 * Ouvre un résultat (RC-03) : vérifie qu'il existe encore, puis navigue selon `resultTarget`. Une tâche s'ouvre en fiche détail par-dessus
 * l'onglet courant (Ctrl+Entrée : dans son onglet) ; les autres types ouvrent leur onglet. Quand l'élément ouvert dans un onglet
 * serait masqué par le filtre d'espace ou de projet global, ce filtre repasse sur « Tout » / « Tous les projets » (sinon l'écran
 * s'ouvrirait sans l'élément). Ne rejette jamais.
 */
export async function openSearchResult(container: Pick<AppContainer, 'data' | 'clock' | 'undo'>, result: SearchResult, options: { readonly inTab: boolean }): Promise<OpenOutcome> {
  try {
    if (!(await stillExists(container, result))) return 'missing';
  } catch {
    return 'failed';
  }
  const target = resultTarget(result.hit, options);
  const app = useAppStore.getState();
  const navigation = useNavigationStore.getState();
  const route = routeOf(target, app.day ?? todayLocal(container.clock));
  if (route) {
    const widenSpace = app.spaceFilter !== 'all' && app.spaceFilter !== result.hit.spaceId;
    // Un filtre projet masquerait l'élément (autre type, ou tâche d'un autre projet) ; élargir l'espace le remet déjà à zéro.
    const widenProject = app.projectFilter !== null && (widenSpace || result.hit.kind !== 'task' || result.hit.projectId !== app.projectFilter);
    if (widenSpace || widenProject) {
      // Un seul message « Annuler » qui annonce ce qui a été élargi et rétablit les deux filtres d'avant.
      const previousSpace = app.spaceFilter;
      const previousProject = app.projectFilter;
      if (widenSpace) app.setSpaceFilter('all');
      else app.setProjectFilter(null);
      container.undo.push({
        kind: 'search',
        count: 1,
        labelKey: widenSpace && widenProject ? 'undo.searchFilters' : widenSpace ? 'undo.searchFilter' : 'undo.searchProjectFilter',
        undo: async () => {
          const state = useAppStore.getState();
          state.setSpaceFilter(previousSpace);
          state.setProjectFilter(previousProject);
          return 'undone';
        },
      });
    }
    navigation.closeDetail();
    navigation.navigate(route);
  }
  if (target.detail) {
    const detail = { type: target.detail.type, id: target.detail.id } as DetailTarget;
    navigation.openDetail(detail);
  }
  return 'opened';
}
