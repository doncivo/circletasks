import { newEntityId } from '../../domain/id';
import { activeProjectsOf, defaultProjectColor, isProjectColorAllowed, moveProject, moveProjectTo, nextProjectOrder, validateProjectName, type ProjectNameError } from '../../domain/projectRules';
import { isSpaceColorAllowed, validateSpaceName, type SpaceNameError } from '../../domain/spaceRules';
import type { Project, Space } from '../../domain/model';
import type { HexColor, ProjectId, Result, SpaceId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Cas d'usage « espaces » (ES-01) : renommer et choisir la couleur de Pro ou Perso. Les règles (nom, palette) sont dans
 * src/domain/spaceRules.ts ; l'écriture passe par `SpaceRepository.update` (hlc : préférence partagée, PRD 6). Il n'existe aucun
 * cas d'usage de création ou de suppression d'espace (ES-01 critère 6).
 */
export type SpaceUseCaseDeps = Pick<AppContainer, 'data' | 'ids'>;

export type SpaceColorError = 'color-not-allowed' | 'space-not-found';

export type ProjectError = ProjectNameError | 'project-not-found' | 'space-not-found' | 'color-not-allowed';

export interface SpaceUseCases {
  /** Tous les espaces, dans l'ordre d'affichage. */
  list(): Promise<Space[]>;
  /** Tous les projets (archivés compris), triés par ordre. */
  listProjects(): Promise<Project[]>;
  /** Renomme un espace après validation ; l'ancien nom reste en cas de refus. Renvoie les espaces à jour. */
  rename(id: SpaceId, raw: string): Promise<Result<Space[], SpaceNameError | 'space-not-found'>>;
  /** Change la couleur, parmi la palette de l'espace seulement. Renvoie les espaces à jour. */
  setColor(id: SpaceId, color: HexColor): Promise<Result<Space[], SpaceColorError>>;
  /**
   * ES-04 : crée un projet à la fin de la liste de l'espace ; couleur par défaut = celle de l'espace. Nom 1 à 50 caractères, unique dans
   * l'espace (casse ignorée), couleur de la palette fixe. Renvoie tous les projets à jour.
   */
  createProject(spaceId: SpaceId, rawName: string, color?: HexColor): Promise<Result<Project[], ProjectError>>;
  /** ES-04 : renomme et / ou change la couleur d'un projet (mêmes règles). Renvoie tous les projets à jour. */
  updateProject(id: ProjectId, patch: { readonly name?: string; readonly color?: HexColor }): Promise<Result<Project[], ProjectError>>;
  /** ES-04 : archive (plus proposé) ou désarchive un projet ; ses tâches gardent leur projet. Renvoie tous les projets à jour. */
  setProjectArchived(id: ProjectId, archived: boolean): Promise<Result<Project[], ProjectError>>;
  /**
   * ES-04 critère 8 : déplace un projet d'un cran (`-1`, `1`) ou à l'index `toIndex` de la liste de son espace
   * (projets actifs seulement ; les archivés suivent) ; l'ordre de la liste « Projet » suit. Renvoie tous les projets à jour.
   */
  moveProject(id: ProjectId, to: { readonly direction: -1 | 1 } | { readonly toIndex: number }): Promise<Result<Project[], ProjectError>>;
}

export function createSpaceUseCases(deps: SpaceUseCaseDeps): SpaceUseCases {
  const { spaces, projects } = deps.data.repos;
  const allProjects = (): Promise<Project[]> => projects.listForFilter('all', { includeArchived: true });
  return {
    list: () => spaces.listAll(),
    listProjects: () => deps.data.repos.projects.listForFilter('all', { includeArchived: true }),

    async rename(id, raw) {
      const all = await spaces.listAll();
      if (!all.some((space) => space.id === id)) return { ok: false, error: 'space-not-found' };
      const checked = validateSpaceName(
        raw,
        all.filter((space) => space.id !== id).map((space) => space.name),
      );
      if (!checked.ok) return checked;
      const current = all.find((space) => space.id === id);
      if (current?.name !== checked.value) await spaces.update(id, { name: checked.value });
      return { ok: true, value: await spaces.listAll() };
    },

    async setColor(id, color) {
      const all = await spaces.listAll();
      if (!all.some((space) => space.id === id)) return { ok: false, error: 'space-not-found' };
      if (!isSpaceColorAllowed(all, id, color)) return { ok: false, error: 'color-not-allowed' };
      if (all.find((space) => space.id === id)?.color !== color) await spaces.update(id, { color });
      return { ok: true, value: await spaces.listAll() };
    },

    async createProject(spaceId, rawName, color) {
      const space = await spaces.getById(spaceId);
      if (!space) return { ok: false, error: 'space-not-found' };
      const existing = await allProjects();
      const checked = validateProjectName(
        rawName,
        existing.filter((project) => project.spaceId === spaceId).map((project) => project.name),
      );
      if (!checked.ok) return checked;
      const chosen = color ?? defaultProjectColor(space);
      if (!isProjectColorAllowed(chosen)) return { ok: false, error: 'color-not-allowed' };
      await projects.create({
        id: newEntityId<ProjectId>(deps.ids),
        spaceId,
        name: checked.value,
        color: chosen,
        archived: false,
        sortOrder: nextProjectOrder(existing, spaceId),
      });
      return { ok: true, value: await allProjects() };
    },

    async updateProject(id, patch) {
      const existing = await allProjects();
      const current = existing.find((project) => project.id === id);
      if (!current) return { ok: false, error: 'project-not-found' };
      const write: { name?: string; color?: HexColor } = {};
      if (patch.name !== undefined) {
        const checked = validateProjectName(
          patch.name,
          existing.filter((project) => project.spaceId === current.spaceId && project.id !== id).map((project) => project.name),
        );
        if (!checked.ok) return checked;
        if (checked.value !== current.name) write.name = checked.value;
      }
      if (patch.color !== undefined) {
        if (!isProjectColorAllowed(patch.color)) return { ok: false, error: 'color-not-allowed' };
        if (patch.color !== current.color) write.color = patch.color;
      }
      if (write.name !== undefined || write.color !== undefined) await projects.update(id, write);
      return { ok: true, value: await allProjects() };
    },

    async setProjectArchived(id, archived) {
      const current = (await allProjects()).find((project) => project.id === id);
      if (!current) return { ok: false, error: 'project-not-found' };
      if (current.archived !== archived) await projects.setArchived(id, archived);
      return { ok: true, value: await allProjects() };
    },

    async moveProject(id, to) {
      const existing = await allProjects();
      const current = existing.find((project) => project.id === id);
      if (!current) return { ok: false, error: 'project-not-found' };
      // L'ordre se règle sur la liste affichée (projets actifs) ; les archivés suivent, dans leur ordre.
      const active = activeProjectsOf(existing, current.spaceId);
      const moved = 'direction' in to ? moveProject(active, id, to.direction) : moveProjectTo(active, id, to.toIndex);
      if (moved.length > 0) {
        const archived = existing.filter((project) => project.spaceId === current.spaceId && project.archived).sort((x, y) => x.sortOrder - y.sortOrder);
        const entries = [...moved, ...archived.map((project, index) => ({ id: project.id, sortOrder: moved.length + 1 + index }))];
        await deps.data.transaction((repos) => repos.projects.setSortOrders(entries));
      }
      return { ok: true, value: await allProjects() };
    },
  };
}
