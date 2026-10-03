import { createStore } from 'zustand';
import { sortChecklistSummaries, sortItems, type ChecklistTextError } from '../../domain/checklistRules';
import type { Checklist, ChecklistItem, ChecklistSummary } from '../../domain/model';
import type { ChecklistId, Result, SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { onChecklistsChanged } from './checklistEvents';
import { createChecklistUseCases, type ChecklistSaveError, type ChecklistUpdate, type NewChecklistInput } from './checklistUseCases';

export type ChecklistsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `create` peut en plus échouer pour une raison imprévue (écriture ou lecture en base). */
export type ChecklistCreateError = ChecklistTextError | 'unexpected';

/**
 * État et actions de l'onglet Checklists (M6). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Le store garde les
 * checklists du filtre d'espace avec leur progression, et les items de la checklist affichée ; la sélection elle-même est la route
 * (`checklistId`, conservée entre deux onglets par `lastRoutes`). Il se relit tout seul quand une checklist change, y compris par
 * « Annuler » (`onChecklistsChanged`).
 */
export interface ChecklistsState {
  readonly filter: SpaceFilter;
  /** Checklists du filtre, triées par titre (accents ignorés). */
  readonly summaries: readonly ChecklistSummary[];
  /** Checklist dont les items sont chargés. */
  readonly selectedId: ChecklistId | null;
  /** Items vivants de la checklist affichée, dans l'ordre manuel. */
  readonly items: readonly ChecklistItem[];
  readonly status: ChecklistsStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action (ajout, suppression…) : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge les checklists du filtre. Ne rejette jamais. */
  load(filter: SpaceFilter): Promise<void>;
  /** Affiche les items de cette checklist (null : aucune). Ne rejette jamais. */
  select(id: ChecklistId | null): Promise<void>;
  /** Relit checklists et items sans passer par `loading`. Ne rejette jamais. */
  refresh(): Promise<void>;
  /** C-01 : crée une checklist. Ne rejette jamais. */
  create(input: NewChecklistInput): Promise<Result<Checklist, ChecklistCreateError>>;
  /** C-01 : titre, icône, espace. Ne rejette jamais. */
  update(id: ChecklistId, patch: ChecklistUpdate): Promise<Result<Checklist, ChecklistSaveError | 'unexpected'>>;
  /** C-01 : supprime (annulable 5 s). Renvoie vrai si c'est fait. Ne rejette jamais. */
  remove(id: ChecklistId): Promise<boolean>;
  /** C-01 : ajoute un item à la checklist affichée. Ne rejette jamais. */
  addItem(text: string): Promise<Result<ChecklistItem, ChecklistSaveError | 'unexpected'>>;
}

export const checklistsStore = defineFeatureStore<ChecklistsState>((container: AppContainer) => {
  const useCases = createChecklistUseCases(container);
  // Jetons de requête : le résultat d'une lecture dépassée par une plus récente est ignoré.
  let requestId = 0;
  let selectId = 0;

  const readSummaries = async (filter: SpaceFilter): Promise<ChecklistSummary[]> => sortChecklistSummaries(await container.data.repos.checklists.listSummaries(filter));
  const readItems = async (id: ChecklistId | null): Promise<ChecklistItem[]> => (id ? sortItems(await container.data.repos.checklistItems.listForChecklist(id)) : []);

  const store = createStore<ChecklistsState>()((set, get) => ({
    filter: 'all',
    summaries: [],
    selectedId: null,
    items: [],
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(filter) {
      const id = ++requestId;
      set({ status: 'loading', filter, errorKey: null, actionErrorKey: null });
      try {
        const summaries = await readSummaries(filter);
        if (id !== requestId) return;
        set({ summaries, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'checklists.loadError' });
      }
    },

    async select(id) {
      const token = ++selectId;
      if (get().selectedId !== id) set({ selectedId: id, items: [] });
      try {
        const items = await readItems(id);
        if (token === selectId) set({ items });
      } catch {
        if (token === selectId) set({ actionErrorKey: 'checklists.loadError' });
      }
    },

    async refresh() {
      if (get().status === 'idle') return;
      const loadToken = requestId;
      const token = ++selectId;
      try {
        const [summaries, items] = await Promise.all([readSummaries(get().filter), readItems(get().selectedId)]);
        if (loadToken === requestId && token === selectId) set({ summaries, items });
      } catch {
        // Relecture discrète : l'affichage reste celui d'avant.
      }
    },

    async create(input) {
      try {
        return await useCases.create(input);
      } catch {
        set({ actionErrorKey: 'checklists.saveError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async update(id, patch) {
      try {
        return await useCases.update(id, patch);
      } catch {
        set({ actionErrorKey: 'checklists.saveError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async remove(id) {
      try {
        const done = await useCases.remove(id);
        set({ actionErrorKey: null });
        return done;
      } catch {
        set({ actionErrorKey: 'checklists.saveError' });
        return false;
      }
    },

    async addItem(text) {
      const id = get().selectedId;
      if (!id) return { ok: false, error: 'not-found' };
      try {
        const result = await useCases.addItem(id, text);
        set({ actionErrorKey: result.ok || result.error !== 'not-found' ? null : 'checklists.itemError' });
        return result;
      } catch {
        set({ actionErrorKey: 'checklists.itemError' });
        return { ok: false, error: 'unexpected' };
      }
    },
  }));

  // Une écriture (de cet écran, d'une annulation, plus tard de la synchro) : la liste se relit.
  onChecklistsChanged(container.data, () => void store.getState().refresh());
  return store;
});
