import { createStore } from 'zustand';
import type { Task } from '../../domain/model';
import type { LocalDate, ProjectId, Result, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { CreateTaskError, CreateTaskInput } from '../tasks/taskUseCases';

export type SomedayStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `create` peut en plus échouer pour une raison imprévue (écriture en base). */
export type SomedayCreateError = CreateTaskError | 'unexpected';

/**
 * État et actions de la liste « Un jour » (M18, SD-01 à SD-04, S-06). Une instance par conteneur (`defineFeatureStore`, ADR 0004).
 * Les tâches ne sont pas recopiées ici : `load` publie toutes les tâches « Un jour » dans `container.taskEntities` (source unique)
 * et les écrans sélectionnent celles du filtre actif (`selectSomedayTasks`) ; une tâche renvoyée dans « Un jour » depuis la fiche,
 * planifiée ou terminée ailleurs entre ou sort de la liste sans rechargement.
 */
export interface SomedayState {
  readonly status: SomedayStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action sur une tâche : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /**
   * Lit toutes les tâches « Un jour » (tous espaces : le filtre s'applique à l'affichage) et les publie. Appelée à chaque affichage
   * de la liste ou du badge : une tâche arrivée par la synchro ou une autre fenêtre y entre. Ne rejette jamais.
   */
  load(): Promise<void>;
  /**
   * SD-01 : crée une tâche (sans date par défaut : `someday` vrai, en tête de liste) ; la tâche est publiée dans la source unique.
   * Ne rejette jamais : les échecs sont renvoyés dans le `Result`.
   */
  create(input: SomedayNewTask): Promise<Result<Task, SomedayCreateError>>;
  /** SD-01 critère 8 : termine ou rouvre une tâche ; terminée, elle quitte la liste et le compteur baisse. Ne rejette jamais. */
  toggleDone(id: TaskId): Promise<void>;
}

/** Tâche à créer depuis « Un jour » : champ d'ajout (sans date) ou feuille « Nouvelle tâche » (`input` complet). */
export type SomedayNewTask = Omit<CreateTaskInput, 'someday' | 'date'> & { readonly spaceId: SpaceId; readonly projectId?: ProjectId | null; readonly date?: LocalDate | null };

export const somedayStore = defineFeatureStore<SomedayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : le résultat d'un chargement dépassé par un plus récent est ignoré.
  let requestId = 0;

  return createStore<SomedayState>()((set, get) => ({
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load() {
      const id = ++requestId;
      // Relecture silencieuse quand la liste est déjà affichée (pas de squelette ni de clignotement).
      set({ status: get().status === 'ready' ? 'ready' : 'loading', errorKey: null });
      try {
        const tasks = await container.data.repos.tasks.listSomeday('all');
        container.taskEntities.publish(tasks);
        if (id === requestId) set({ status: 'ready' });
      } catch {
        if (id === requestId) set({ status: 'error', errorKey: 'someday.loadError' });
      }
    },

    async create(input) {
      try {
        // Sans date choisie : tâche « Un jour » (SD-01) ; avec une date (feuille d'ajout) : tâche datée ordinaire.
        const dated = input.date !== undefined && input.date !== null;
        const result = await useCases.create({ ...input, ...(dated ? {} : { someday: true, date: null }) });
        set({ actionErrorKey: result.ok ? null : get().actionErrorKey });
        return result;
      } catch {
        set({ actionErrorKey: 'someday.addError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async toggleDone(id) {
      const current = container.taskEntities.get(id);
      if (!current) return;
      try {
        // Le cas d'usage publie la tâche écrite dans la source unique : terminée, elle quitte la liste (`isInSomedayList`).
        if (current.status === 'done') await useCases.reopen(id);
        else await useCases.complete(id);
        set({ actionErrorKey: null });
      } catch {
        set({ actionErrorKey: 'tasks.completeError' });
      }
    },
  }));
});
