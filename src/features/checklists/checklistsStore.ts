import { createStore } from 'zustand';
import { sortChecklistSummaries, sortItems, type ChecklistTextError } from '../../domain/checklistRules';
import type { Checklist, ChecklistItem, ChecklistSummary } from '../../domain/model';
import type { ChecklistId, ChecklistItemId, LocalDate, Result, SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createSettingsUseCases } from '../settings/settingsUseCases';
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
  /** Checklist à afficher (ses items se chargent). */
  readonly selectedId: ChecklistId | null;
  /** Checklist à laquelle appartiennent `items` (différente de `selectedId` le temps du chargement). */
  readonly itemsFor: ChecklistId | null;
  /** Items vivants de la checklist affichée, dans l'ordre manuel. */
  readonly items: readonly ChecklistItem[];
  /** A-06, C-02 critère 9 : vue compacte (`view.compact.checklists`, local à l'appareil), lue au chargement. */
  readonly compact: boolean;
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
  /** A-06 : bascule la vue compacte et la mémorise. Ne rejette jamais. */
  setCompact(compact: boolean): Promise<void>;
  /** C-01 : crée une checklist. Ne rejette jamais. */
  create(input: NewChecklistInput): Promise<Result<Checklist, ChecklistCreateError>>;
  /** C-01 : titre, icône, espace. Ne rejette jamais. */
  update(id: ChecklistId, patch: ChecklistUpdate): Promise<Result<Checklist, ChecklistSaveError | 'unexpected'>>;
  /** C-04 : duplique et réinitialise (annulable 5 s) ; renvoie la copie, null en cas d'échec. Ne rejette jamais. */
  duplicate(id: ChecklistId): Promise<Checklist | null>;
  /** C-03 : associe la checklist à un jour, ou retire la date (null, annulable 5 s). Renvoie vrai si c'est fait. Ne rejette jamais. */
  setDate(id: ChecklistId, date: LocalDate | null): Promise<boolean>;
  /** C-01 : supprime (annulable 5 s). Renvoie vrai si c'est fait. Ne rejette jamais. */
  remove(id: ChecklistId): Promise<boolean>;
  /** C-01 : ajoute un item à la checklist affichée. Ne rejette jamais. */
  addItem(text: string): Promise<Result<ChecklistItem, ChecklistSaveError | 'unexpected'>>;
  /**
   * C-02 : coche ou décoche un item. L'état voulu est lu à l'instant du geste et affiché aussitôt ; les écritures d'un même item sont
   * mises en file, la dernière gagne (deux gestes rapides ne perdent aucune bascule). Ne rejette jamais.
   */
  toggleItem(id: ChecklistItemId): void;
  /** C-05 : « Effacer les cochés » de la checklist affichée (annulable 5 s) ; renvoie le nombre d'items effacés. Ne rejette jamais. */
  clearChecked(): Promise<number>;
  /** C-05 : « Tout décocher » de la checklist affichée (annulable 5 s) ; renvoie le nombre d'items décochés. Ne rejette jamais. */
  uncheckAll(): Promise<number>;
  /** C-05 : place l'item à la position `toIndex` (annulable) ; renvoie la position finale, null si rien ne change. Ne rejette jamais. */
  moveItem(id: ChecklistItemId, toIndex: number): Promise<{ readonly position: number; readonly total: number } | null>;
  /** C-05 : « − » supprime un item (annulable 5 s). Renvoie vrai si c'est fait. Ne rejette jamais. */
  removeItem(id: ChecklistItemId): Promise<boolean>;
  /** C-02 : texte modifié en ligne. Ne rejette jamais. */
  renameItem(id: ChecklistItemId, text: string): Promise<Result<ChecklistItem, ChecklistSaveError | 'unexpected'>>;
}

export const checklistsStore = defineFeatureStore<ChecklistsState>((container: AppContainer) => {
  const useCases = createChecklistUseCases(container);
  const settingsUseCases = createSettingsUseCases(container);
  // Jetons de requête : le résultat d'une lecture dépassée par une plus récente est ignoré.
  let requestId = 0;
  let selectId = 0;
  // État coché voulu des items dont l'écriture est en cours : une relecture ne le remet jamais en cause (pas de scintillement).
  const wanted = new Map<ChecklistItemId, boolean>();
  const inflight = new Map<ChecklistItemId, number>();
  const chains = new Map<ChecklistItemId, Promise<unknown>>();

  /** Attend les cochages en cours : un lot (« Effacer les cochés ») voit l'état que l'utilisateur voit. */
  const settleToggles = async (): Promise<void> => {
    await Promise.all([...chains.values()]);
  };

  const readSummaries = async (filter: SpaceFilter): Promise<ChecklistSummary[]> => sortChecklistSummaries(await container.data.repos.checklists.listSummaries(filter));
  const readItems = async (id: ChecklistId | null): Promise<ChecklistItem[]> => {
    if (!id) return [];
    const items = sortItems(await container.data.repos.checklistItems.listForChecklist(id));
    return items.map((item) => (wanted.has(item.id as ChecklistItemId) ? { ...item, checked: wanted.get(item.id as ChecklistItemId) === true } : item));
  };

  const store = createStore<ChecklistsState>()((set, get) => ({
    filter: 'all',
    summaries: [],
    selectedId: null,
    itemsFor: null,
    items: [],
    compact: false,
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(filter) {
      const id = ++requestId;
      set({ status: 'loading', filter, errorKey: null, actionErrorKey: null });
      try {
        const summaries = await readSummaries(filter);
        // Réglage illisible : vue détaillée par défaut.
        const compact = await container.data.repos.settings.get('view.compact').then((value) => value.checklists, () => false);
        if (id !== requestId) return;
        set({ summaries, compact, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'checklists.loadError' });
      }
    },

    async select(id) {
      const token = ++selectId;
      if (get().selectedId !== id) set({ selectedId: id });
      try {
        const items = await readItems(id);
        if (token === selectId) set({ items, itemsFor: id });
      } catch {
        if (token === selectId) set({ actionErrorKey: 'checklists.loadError' });
      }
    },

    async refresh() {
      if (get().status === 'idle') return;
      const loadToken = requestId;
      const token = ++selectId;
      const shown = get().selectedId;
      try {
        const [summaries, items] = await Promise.all([readSummaries(get().filter), readItems(shown)]);
        if (loadToken === requestId && token === selectId) set({ summaries, items, itemsFor: shown });
      } catch {
        // Relecture discrète : l'affichage reste celui d'avant.
      }
    },

    async setCompact(compact) {
      const previous = get().compact;
      set({ compact });
      try {
        await settingsUseCases.setCompactView('checklists', compact);
      } catch {
        set({ compact: previous, actionErrorKey: 'checklists.saveError' });
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

    async duplicate(id) {
      try {
        const copy = await useCases.duplicate(id);
        set({ actionErrorKey: copy ? null : 'checklists.saveError' });
        return copy;
      } catch {
        set({ actionErrorKey: 'checklists.saveError' });
        return null;
      }
    },

    async setDate(id, date) {
      try {
        const written = await useCases.setDate(id, date);
        set({ actionErrorKey: null });
        return written !== null;
      } catch {
        set({ actionErrorKey: 'checklists.saveError' });
        return false;
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

    toggleItem(id) {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item) return;
      const checked = !(wanted.get(id) ?? item.checked);
      wanted.set(id, checked);
      inflight.set(id, (inflight.get(id) ?? 0) + 1);
      set({ items: get().items.map((candidate) => (candidate.id === id ? { ...candidate, checked } : candidate)) });
      const write = (chains.get(id) ?? Promise.resolve()).then(() => useCases.setChecked(id, checked));
      const settled = write
        .catch(() => {
          set({ actionErrorKey: 'checklists.itemError' });
        })
        .finally(() => {
          const left = (inflight.get(id) ?? 1) - 1;
          if (left > 0) {
            inflight.set(id, left);
            return;
          }
          inflight.delete(id);
          wanted.delete(id);
          chains.delete(id);
          void get().refresh();
        });
      chains.set(id, settled);
    },

    async clearChecked() {
      const id = get().selectedId;
      if (!id) return 0;
      try {
        await settleToggles();
        const cleared = await useCases.clearChecked(id);
        set({ actionErrorKey: null });
        return cleared.length;
      } catch {
        set({ actionErrorKey: 'checklists.itemError' });
        return 0;
      }
    },

    async uncheckAll() {
      const id = get().selectedId;
      if (!id) return 0;
      try {
        await settleToggles();
        const unchecked = await useCases.uncheckAll(id);
        set({ actionErrorKey: null });
        return unchecked.length;
      } catch {
        set({ actionErrorKey: 'checklists.itemError' });
        return 0;
      }
    },

    async moveItem(itemId, toIndex) {
      const id = get().selectedId;
      if (!id) return null;
      try {
        const moved = await useCases.moveItem(id, itemId, toIndex);
        set({ actionErrorKey: null });
        return moved;
      } catch {
        set({ actionErrorKey: 'checklists.itemError' });
        return null;
      }
    },

    async removeItem(itemId) {
      try {
        const done = await useCases.removeItem(itemId);
        set({ actionErrorKey: null });
        return done;
      } catch {
        set({ actionErrorKey: 'checklists.itemError' });
        return false;
      }
    },

    async renameItem(id, text) {
      try {
        const result = await useCases.renameItem(id, text);
        set({ actionErrorKey: null });
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
