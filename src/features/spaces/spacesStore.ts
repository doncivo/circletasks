import { createStore } from 'zustand';
import type { SpaceNameError } from '../../domain/spaceRules';
import type { Project, Space } from '../../domain/model';
import type { HexColor, SpaceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { createSpaceUseCases } from './spaceUseCases';

export type SpacesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Résultat d'un enregistrement de nom : 'ok', le motif du refus de validation, ou 'error' (écriture impossible). */
export type SpaceRenameOutcome = 'ok' | SpaceNameError | 'error';

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
}

const publish = (spaces: readonly Space[]): void => useAppStore.getState().setSpaces(spaces);

export const spacesStore = defineFeatureStore<SpacesState>((container: AppContainer) => {
  const useCases = createSpaceUseCases(container);
  return createStore<SpacesState>()((set) => ({
    status: 'idle',
    errorKey: null,
    projects: [],

    async load() {
      set({ status: 'loading', errorKey: null });
      try {
        const [spaces, projects] = await Promise.all([useCases.list(), useCases.listProjects()]);
        publish(spaces);
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
  }));
});
