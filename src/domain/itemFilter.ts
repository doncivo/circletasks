import { effectiveProjectFilter } from './projectRules';
import type { Project } from './model';
import { matchesSpaceFilter } from './spaceRules';
import type { ProjectId, SpaceFilter, SpaceId } from './types';

/**
 * Filtre unique appliqué à toute donnée portant `spaceId` / `projectId` (ES-08) : espace Pro / Perso / Tout et projet (id ou aucun
 * filtre). Même filtre pour Aujourd'hui, la Semaine, Un jour, les statistiques et le Focus.
 */
export interface ItemFilter {
  readonly space: SpaceFilter;
  /** null = « Tous les projets » (aucun filtre projet). */
  readonly project: ProjectId | null;
}

export const ALL_ITEMS: ItemFilter = { space: 'all', project: null };

/** Un élément porte au plus un espace et un projet ; sans projet, il n'appartient qu'à « Tous les projets ». */
export interface ItemRef {
  readonly spaceId: SpaceId | string;
  readonly projectId?: ProjectId | string | null;
}

/**
 * L'élément passe-t-il le filtre ? L'espace suit `matchesSpaceFilter` ; un filtre projet ne garde que les éléments de ce projet (un
 * élément sans projet n'est compté que dans « Tous les projets », ES-08 critère 4).
 */
export function matchesItemFilter(item: ItemRef, filter: ItemFilter): boolean {
  if (!matchesSpaceFilter(item, filter.space)) return false;
  return filter.project === null || (item.projectId ?? null) === filter.project;
}

/**
 * Filtre effectif construit depuis l'état global (filtre d'espace + projet choisi) : le projet n'est retenu que s'il est actif dans
 * l'espace filtré (QB-15 : masqué en « Tout », remis à « Tous » en changeant d'espace).
 */
export function itemFilterOf(space: SpaceFilter, project: ProjectId | null, projects: readonly Pick<Project, 'id' | 'spaceId' | 'archived' | 'sortOrder'>[]): ItemFilter {
  return { space, project: effectiveProjectFilter(space, project, projects) };
}
