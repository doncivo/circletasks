import { isSpaceColorAllowed, validateSpaceName, type SpaceNameError } from '../../domain/spaceRules';
import type { Project, Space } from '../../domain/model';
import type { HexColor, Result, SpaceId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Cas d'usage « espaces » (ES-01) : renommer et choisir la couleur de Pro ou Perso. Les règles (nom, palette) sont dans
 * src/domain/spaceRules.ts ; l'écriture passe par `SpaceRepository.update` (hlc : préférence partagée, PRD 6). Il n'existe aucun
 * cas d'usage de création ou de suppression d'espace (ES-01 critère 6).
 */
export type SpaceUseCaseDeps = Pick<AppContainer, 'data'>;

export type SpaceColorError = 'color-not-allowed' | 'space-not-found';

export interface SpaceUseCases {
  /** Tous les espaces, dans l'ordre d'affichage. */
  list(): Promise<Space[]>;
  /** Tous les projets (archivés compris), triés par ordre. */
  listProjects(): Promise<Project[]>;
  /** Renomme un espace après validation ; l'ancien nom reste en cas de refus. Renvoie les espaces à jour. */
  rename(id: SpaceId, raw: string): Promise<Result<Space[], SpaceNameError | 'space-not-found'>>;
  /** Change la couleur, parmi la palette de l'espace seulement. Renvoie les espaces à jour. */
  setColor(id: SpaceId, color: HexColor): Promise<Result<Space[], SpaceColorError>>;
}

export function createSpaceUseCases(deps: SpaceUseCaseDeps): SpaceUseCases {
  const { spaces } = deps.data.repos;
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
  };
}
