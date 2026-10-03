import type { Project, Space } from './model';
import { activeProjectsOf, projectForSpace } from './projectRules';
import type { ProjectId, SpaceId } from './types';

/**
 * Déplacement d'un élément vers un autre espace et / ou projet (ES-05). Règle unique pour le détail, la sélection multiple (« Déplacer »
 * de la barre du mode édition, Q12) et, à l'ordre 2, les événements et checklists.
 */

/** Destination d'un déplacement : un espace et, facultativement, un de ses projets. */
export interface MoveTarget {
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
}

/**
 * Destination cohérente : un projet n'est valable que dans son espace (ES-05 critère 1). Un projet inconnu, supprimé ou d'un autre
 * espace est remplacé par « aucun projet ».
 */
export function resolveMoveTarget(spaceId: SpaceId, projectId: ProjectId | null, projects: readonly Pick<Project, 'id' | 'spaceId'>[]): MoveTarget {
  return { spaceId, projectId: projectForSpace(projects, spaceId, projectId) };
}

/** L'élément change-t-il vraiment d'espace ou de projet ? (un déplacement sans effet n'écrit rien) */
export function changesPlacement(item: { readonly spaceId: SpaceId; readonly projectId?: ProjectId | null }, target: MoveTarget): boolean {
  return item.spaceId !== target.spaceId || (item.projectId ?? null) !== target.projectId;
}

/**
 * `moveToSpace(item, spaceId, projectId?)` : copie de l'élément placée dans la destination, projet remis à zéro s'il n'appartient pas
 * à l'espace choisi (déplacer une tâche de Pro / « Mission client » vers Perso la laisse sans projet). Tout le reste (date, heure,
 * rappels, objectif, statut) est conservé (critère 7).
 */
export function moveToSpace<T extends { readonly spaceId: SpaceId; readonly projectId?: ProjectId | null }>(
  item: T,
  spaceId: SpaceId,
  projectId: ProjectId | null,
  projects: readonly Pick<Project, 'id' | 'spaceId'>[],
): T {
  const target = resolveMoveTarget(spaceId, projectId, projects);
  return { ...item, spaceId: target.spaceId, projectId: target.projectId };
}

/**
 * Destinations proposées par « Déplacer » (Q12) : pour chaque espace, « aucun projet » puis ses projets actifs, dans l'ordre des
 * Réglages. L'interface les présente en une liste d'une pression (« Perso · aucun projet », « Pro · Mission client »).
 */
export function moveDestinations(spaces: readonly Pick<Space, 'id' | 'sortOrder'>[], projects: readonly Pick<Project, 'id' | 'spaceId' | 'archived' | 'sortOrder'>[]): MoveTarget[] {
  return [...spaces]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((space) => [
      { spaceId: space.id, projectId: null },
      ...activeProjectsOf(projects, space.id).map((project) => ({ spaceId: space.id, projectId: project.id })),
    ]);
}
