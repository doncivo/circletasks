import { createStore } from 'zustand';
import { effectiveProjectFilter, type ProjectNameError } from '../../domain/projectRules';
import type { SpaceNameError } from '../../domain/spaceRules';
import type { Project, QuietHours, Space } from '../../domain/model';
import type { QuietHoursError } from '../../domain/quietHours';
import type { HexColor, ProjectId, SpaceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import type { Result } from '../../domain/types';
import { createQuietHoursUseCases } from './quietHoursUseCases';
import { createSpaceUseCases, type ProjectError } from './spaceUseCases';

export type SpacesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Résultat d'un enregistrement de nom : 'ok', le motif du refus de validation, ou 'error' (écriture impossible). */
export type SpaceRenameOutcome = 'ok' | SpaceNameError | 'error';

/** Résultat de l'enregistrement des plages silencieuses : 'ok', la première plage refusée (rang et motif), ou 'error' (écriture impossible). */
export type QuietHoursOutcome = 'ok' | { readonly index: number; readonly error: QuietHoursError } | 'error';

/** Résultat d'une écriture de projet : 'ok', le motif de refus de validation, ou 'error' (écriture impossible). */
export type ProjectOutcome = 'ok' | ProjectNameError | 'error';

/**
 * État de l'écran « Espaces et projets » (M13). La liste des espaces reste dans `useAppStore.spaces` (source unique lue par toutes
 * les pastilles, cartes et fiches) : chaque écriture la republie, donc le nouveau nom ou la nouvelle couleur apparaissent partout
 * sans redémarrage (ES-01 critère 3).
 */
export interface SpacesState {
  readonly status: SpacesStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Projets non supprimés, archivés compris (compteurs, liste de Réglages ; ES-04). */
  readonly projects: readonly Project[];
  /** (Re)lit les espaces et les publie dans `useAppStore`. Ne rejette jamais. */
  load(): Promise<void>;
  /** ES-01 : renomme un espace (nom validé, ancien nom conservé en cas de refus). Ne rejette jamais. */
  renameSpace(id: SpaceId, raw: string): Promise<SpaceRenameOutcome>;
  /** ES-01 : choisit une couleur de la palette de l'espace. Ne rejette jamais ; renvoie vrai si c'est enregistré. */
  setSpaceColor(id: SpaceId, color: HexColor): Promise<boolean>;
  /** ES-07 : enregistre les plages silencieuses d'un espace après validation (l'ancien réglage reste en cas de refus). Ne rejette jamais. */
  saveQuietHours(spaceId: SpaceId, ranges: readonly QuietHours[]): Promise<QuietHoursOutcome>;
  /** ES-04 : crée un projet dans l'espace (couleur par défaut : celle de l'espace). Ne rejette jamais. */
  createProject(spaceId: SpaceId, name: string, color?: HexColor): Promise<ProjectOutcome>;
  /** ES-04 : renomme et / ou recolore un projet. Ne rejette jamais. */
  updateProject(id: ProjectId, patch: { readonly name?: string; readonly color?: HexColor }): Promise<ProjectOutcome>;
  /** ES-04 : archive ou désarchive un projet. Ne rejette jamais ; renvoie vrai si c'est enregistré. */
  setProjectArchived(id: ProjectId, archived: boolean): Promise<boolean>;
  /** ES-04 critère 8 : déplace un projet d'un cran ou à un index de la liste de son espace. Ne rejette jamais ; renvoie vrai si c'est enregistré. */
  moveProject(id: ProjectId, to: { readonly direction: -1 | 1 } | { readonly toIndex: number }): Promise<boolean>;
}

const publish = (spaces: readonly Space[]): void => useAppStore.getState().setSpaces(spaces);

/** Publie les projets ; le filtre projet choisi est retiré s'il n'est plus actif dans l'espace filtré (archivage, QB-15). */
const publishProjects = (projects: readonly Project[]): void => {
  const app = useAppStore.getState();
  app.setProjects(projects);
  if (app.projectFilter !== null && effectiveProjectFilter(app.spaceFilter, app.projectFilter, projects) === null) app.setProjectFilter(null);
};

export const spacesStore = defineFeatureStore<SpacesState>((container: AppContainer) => {
  const useCases = createSpaceUseCases(container);
  const quiet = createQuietHoursUseCases(container);
  return createStore<SpacesState>()((set) => {
    const runProject = async (work: () => Promise<Result<Project[], ProjectError>>): Promise<Result<Project[], ProjectError | 'unexpected'>> => {
      try {
        return await work();
      } catch {
        return { ok: false, error: 'unexpected' };
      }
    };
    /** Publie le résultat d'une écriture de projet ; un échec inattendu pose le message d'erreur de l'écran. */
    const writeProjects = (result: Result<Project[], ProjectError | 'unexpected'>): Promise<ProjectOutcome> => {
      if (result.ok) {
        publishProjects(result.value);
        set({ projects: result.value, errorKey: null });
        return Promise.resolve('ok');
      }
      if (result.error === 'empty-name' || result.error === 'name-too-long' || result.error === 'name-taken') return Promise.resolve(result.error);
      set({ errorKey: 'spaces.saveError' });
      return Promise.resolve('error');
    };
    return {
      status: 'idle',
      errorKey: null,
      projects: [],

      async load() {
        set({ status: 'loading', errorKey: null });
        try {
          const [spaces, projects] = await Promise.all([useCases.list(), useCases.listProjects()]);
          publish(spaces);
          publishProjects(projects);
          set({ projects, status: 'ready' });
        } catch {
          set({ status: 'error', errorKey: 'spaces.loadError' });
        }
      },

      async renameSpace(id, raw) {
        try {
          const result = await useCases.rename(id, raw);
          if (!result.ok) {
            if (result.error === 'space-not-found') {
              set({ errorKey: 'spaces.saveError' });
              return 'error';
            }
            return result.error;
          }
          publish(result.value);
          set({ errorKey: null });
          return 'ok';
        } catch {
          set({ errorKey: 'spaces.saveError' });
          return 'error';
        }
      },

      async setSpaceColor(id, color) {
        try {
          const result = await useCases.setColor(id, color);
          if (!result.ok) {
            set({ errorKey: 'spaces.saveError' });
            return false;
          }
          publish(result.value);
          set({ errorKey: null });
          return true;
        } catch {
          set({ errorKey: 'spaces.saveError' });
          return false;
        }
      },

      async saveQuietHours(spaceId, ranges) {
        try {
          const result = await quiet.save(spaceId, ranges);
          if (!result.ok) {
            if (result.error === 'space-not-found') {
              set({ errorKey: 'spaces.saveError' });
              return 'error';
            }
            return result.error;
          }
          publish(result.value);
          set({ errorKey: null });
          return 'ok';
        } catch {
          set({ errorKey: 'spaces.saveError' });
          return 'error';
        }
      },

      async createProject(spaceId, name, color) {
        return writeProjects(await runProject(() => useCases.createProject(spaceId, name, color)));
      },

      async updateProject(id, patch) {
        return writeProjects(await runProject(() => useCases.updateProject(id, patch)));
      },

      async setProjectArchived(id, archived) {
        return (await writeProjects(await runProject(() => useCases.setProjectArchived(id, archived)))) === 'ok';
      },

      async moveProject(id, to) {
        return (await writeProjects(await runProject(() => useCases.moveProject(id, to)))) === 'ok';
      },
    };
  });
});
