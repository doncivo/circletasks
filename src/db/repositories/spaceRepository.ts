import type { NewProject, NewSpace, Project, ProjectPatch, Space, SpacePatch } from '../../domain/model';
import type { ProjectId, SpaceFilter, SpaceId } from '../../domain/types';
import type { ReadOptions, SortOrderEntry } from './common';

/** Espaces Pro / Perso (M13, ES-01, ES-07). Pas de suppression d'espace à l'ordre 1. */
export interface SpaceRepository {
  /** Tous les espaces, triés par `sort_order`. */
  listAll(): Promise<Space[]>;
  getById(id: SpaceId, options?: ReadOptions): Promise<Space | null>;
  /** Nombre d'espaces non supprimés (création des espaces par défaut, ES-01). */
  count(): Promise<number>;
  create(space: NewSpace): Promise<Space>;
  /** Renommer, changer de couleur, plages silencieuses (ES-01, ES-07). */
  update(id: SpaceId, patch: SpacePatch): Promise<Space>;
  setSortOrders(entries: readonly SortOrderEntry<SpaceId>[]): Promise<void>;
}

/** Projets facultatifs (ES-04, ES-05). */
export interface ProjectRepository {
  /** Projets du filtre, triés par `sort_order` ; archivés exclus par défaut. */
  listForFilter(filter: SpaceFilter, options?: { readonly includeArchived?: boolean }): Promise<Project[]>;
  getById(id: ProjectId, options?: ReadOptions): Promise<Project | null>;
  create(project: NewProject): Promise<Project>;
  update(id: ProjectId, patch: ProjectPatch): Promise<Project>;
  setArchived(id: ProjectId, archived: boolean): Promise<Project>;
  setSortOrders(entries: readonly SortOrderEntry<ProjectId>[]): Promise<void>;
  softDelete(id: ProjectId): Promise<Project>;
  restore(id: ProjectId): Promise<Project>;
}
