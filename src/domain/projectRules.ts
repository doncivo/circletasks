import type { Project, Space } from './model';
import { PROJECT_PALETTE, sameName } from './spaceRules';
import type { HexColor, ProjectId, Result, SpaceFilter, SpaceId } from './types';

/** Longueur maximale du nom d'un projet (ES-04 critère 2). */
export const PROJECT_NAME_MAX_LENGTH = 50;

export type ProjectNameError = 'empty-name' | 'name-too-long' | 'name-taken';

/**
 * Valide le nom d'un projet (ES-04 critère 2) : 1 à 50 caractères après nettoyage, unique dans son espace sans tenir compte de la
 * casse ; deux espaces peuvent avoir un projet de même nom. `namesInSpace` = noms des AUTRES projets de l'espace (archivés compris :
 * désarchiver ne doit jamais créer de doublon).
 */
export function validateProjectName(raw: string, namesInSpace: readonly string[]): Result<string, ProjectNameError> {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'empty-name' };
  if (name.length > PROJECT_NAME_MAX_LENGTH) return { ok: false, error: 'name-too-long' };
  if (namesInSpace.some((other) => sameName(other, name))) return { ok: false, error: 'name-taken' };
  return { ok: true, value: name };
}

/** Une couleur de projet appartient-elle à la palette fixe ? (ES-04 critère 3) */
export function isProjectColorAllowed(color: string): boolean {
  return PROJECT_PALETTE.some((choice) => choice.hex === color);
}

/** Couleur proposée à un nouveau projet : celle de son espace (ES-04 critère 3). */
export function defaultProjectColor(space: Pick<Space, 'color'>): HexColor {
  return space.color;
}

type ProjectLike = Pick<Project, 'id' | 'spaceId' | 'archived' | 'sortOrder'> & { readonly deletedAt?: string | null };

/** Projets actifs d'un espace (ni archivés ni supprimés), dans l'ordre choisi (ES-04 critères 4 et 8). */
export function activeProjectsOf<P extends ProjectLike>(projects: readonly P[], spaceId: SpaceId | string): P[] {
  return projects
    .filter((project) => project.spaceId === spaceId && !project.archived && (project.deletedAt ?? null) === null)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Projets proposés pour un élément de `spaceId` (liste déroulante « Projet », ES-04 critère 4) : les projets actifs de CET espace
 * seulement. `currentProjectId` : le projet déjà porté par l'élément reste affiché même archivé (critère 5), sans être proposé aux autres.
 */
export function projectChoicesFor<P extends ProjectLike>(projects: readonly P[], spaceId: SpaceId | string, currentProjectId: ProjectId | null = null): P[] {
  const active = activeProjectsOf(projects, spaceId);
  if (currentProjectId === null || active.some((project) => project.id === currentProjectId)) return active;
  const current = projects.find((project) => project.id === currentProjectId && project.spaceId === spaceId);
  return current ? [...active, current] : active;
}

/**
 * Règle « projet de l'espace de l'élément » (ES-04 critère 4, ES-05 critère 1) : un projet n'est valable que dans son espace. Rend le
 * projet à garder quand l'élément est (ou passe) dans `spaceId` : le projet demandé s'il appartient à cet espace, sinon aucun.
 */
export function projectForSpace(projects: readonly Pick<Project, 'id' | 'spaceId'>[], spaceId: SpaceId | string, projectId: ProjectId | null): ProjectId | null {
  if (projectId === null) return null;
  return projects.some((project) => project.id === projectId && project.spaceId === spaceId) ? projectId : null;
}

/**
 * QB-15 : le menu « Projet : tous » est visible sous Pro ou Perso quand l'espace filtré a au moins un projet actif ; masqué en « Tout »
 * et pour un espace sans projet (aucun filtre projet ne s'applique alors).
 */
export function isProjectFilterAvailable(filter: SpaceFilter, projects: readonly ProjectLike[]): boolean {
  return filter !== 'all' && activeProjectsOf(projects, filter).length > 0;
}

/**
 * Filtre projet effectivement appliqué (ES-04 critère 6, QB-15) : le projet choisi seulement s'il est actif dans l'espace filtré ;
 * sinon `null` (« Tous les projets »). Changer d'espace, archiver le projet choisi ou passer en « Tout » retire donc le filtre.
 */
export function effectiveProjectFilter(filter: SpaceFilter, projectId: ProjectId | null, projects: readonly ProjectLike[]): ProjectId | null {
  if (projectId === null || filter === 'all') return null;
  return activeProjectsOf(projects, filter).some((project) => project.id === projectId) ? projectId : null;
}

/** Entrée d'un nouvel ordre. */
export interface OrderEntry<T> {
  readonly id: T;
  readonly sortOrder: number;
}

/**
 * Nouvel ordre après avoir déplacé un projet d'un cran (`-1` vers le haut, `1` vers le bas) dans la liste de son espace (Alt+↑ / Alt+↓,
 * ES-04 critère 8). Les ordres sont renumérotés 1, 2, 3… ; liste inchangée (tableau vide) si le déplacement sort de la liste.
 */
export function moveProject(ordered: readonly Pick<Project, 'id'>[], id: ProjectId, direction: -1 | 1): OrderEntry<ProjectId>[] {
  const from = ordered.findIndex((project) => project.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ordered.length) return [];
  const ids = ordered.map((project) => project.id);
  const [moved] = ids.splice(from, 1);
  if (moved === undefined) return [];
  ids.splice(to, 0, moved);
  return ids.map((projectId, index) => ({ id: projectId, sortOrder: index + 1 }));
}

/** Même opération pour un glisser-déposer : `id` est placé à l'index `toIndex` de la liste. */
export function moveProjectTo(ordered: readonly Pick<Project, 'id'>[], id: ProjectId, toIndex: number): OrderEntry<ProjectId>[] {
  const from = ordered.findIndex((project) => project.id === id);
  if (from < 0 || toIndex < 0 || toIndex >= ordered.length || toIndex === from) return [];
  const ids = ordered.map((project) => project.id);
  const [moved] = ids.splice(from, 1);
  if (moved === undefined) return [];
  ids.splice(toIndex, 0, moved);
  return ids.map((projectId, index) => ({ id: projectId, sortOrder: index + 1 }));
}

/** Ordre du prochain projet d'un espace : après le dernier (archivés compris). */
export function nextProjectOrder(projects: readonly Pick<Project, 'spaceId' | 'sortOrder'>[], spaceId: SpaceId | string): number {
  return projects.filter((project) => project.spaceId === spaceId).reduce((max, project) => Math.max(max, project.sortOrder), 0) + 1;
}
