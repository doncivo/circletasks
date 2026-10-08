import { createStore } from 'zustand';
import type { Task } from '../../domain/model';
import { moveTaskRow, type MoveOutcome } from '../../domain/taskReorder';
import type { TodayRow } from '../../domain/todayList';
import type { ScheduleSomedayTarget } from '../../domain/someday';
import type { LocalDate, ProjectId, Result, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createSettingsUseCases } from '../settings/settingsUseCases';
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
  toggleDone(id: TaskId): Promise<boolean>;
  /**
   * SD-02, S-06 : planifie des tâches (« Aujourd'hui », « Demain » ou une date avec heure facultative) ; elles quittent la liste, le badge
   * baisse, un message « Annuler » de 5 s est posé (une seule annulation pour tout le lot). Ne rejette jamais.
   */
  schedule(ids: readonly TaskId[], target: ScheduleSomedayTarget): Promise<boolean>;
  /** A-06, SD-04 critère 7 : vue compacte de « Un jour » (`view.compact.someday`, local à l'appareil), lue au chargement. */
  readonly compact: boolean;
  /** A-05 : mode édition (suppression, poignées, sélection multiple) ; jamais mémorisé. */
  readonly editMode: boolean;
  /** A-05 : tâches sélectionnées (les identifiants non affichés sont ignorés par l'écran). */
  readonly selection: ReadonlySet<TaskId>;
  /** A-06 : bascule la vue compacte et la mémorise, sans toucher aux autres écrans. Ne rejette jamais. */
  setCompact(compact: boolean): Promise<void>;
  /** A-05 : active ou coupe le mode édition ; la sélection est vidée dans les deux cas. */
  setEditMode(active: boolean): void;
  toggleSelection(id: TaskId): void;
  addToSelection(ids: readonly TaskId[]): void;
  clearSelection(): void;
  /**
   * A-02, SD-04 critère 1 : déplace la tâche `id` à la position `toIndex` de `rows` (liste affichée) ; l'ordre (`sort_order`) est écrit
   * puis annulable. Renvoie le résultat (null : élément non déplaçable ou échec, `actionErrorKey` posé). Ne rejette jamais.
   */
  moveRow(rows: readonly TodayRow[], id: string, toIndex: number): Promise<MoveOutcome | null>;
  /** SD-04 critère 6 : planifie la sélection (« Planifier » de la barre), un seul message « Annuler », puis la vide. Ne rejette jamais. */
  scheduleSelected(ids: readonly TaskId[], target: ScheduleSomedayTarget): Promise<void>;
  /** SD-04 critère 8 : supprime des tâches vers la corbeille (T-08, un seul message « Annuler »), puis vide la sélection. Ne rejette jamais. */
  remove(ids: readonly TaskId[]): Promise<void>;
  /** SD-04 critère 5, Q12 : déplace des tâches vers un espace (et un projet), sans changer la date ; annulable en une fois. Ne rejette jamais. */
  moveToSpace(ids: readonly TaskId[], spaceId: SpaceId, projectId: ProjectId | null): Promise<void>;
}

/** Tâche à créer depuis « Un jour » : champ d'ajout (sans date) ou feuille « Nouvelle tâche » (`input` complet). */
export type SomedayNewTask = Omit<CreateTaskInput, 'someday' | 'date'> & { readonly spaceId: SpaceId; readonly projectId?: ProjectId | null; readonly date?: LocalDate | null };

/** La sélection sans les tâches traitées (planifiées, supprimées, déplacées hors de la vue). */
function without(selection: ReadonlySet<TaskId>, ids: readonly TaskId[]): ReadonlySet<TaskId> {
  const next = new Set(selection);
  for (const id of ids) next.delete(id);
  return next;
}

export const somedayStore = defineFeatureStore<SomedayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  const settingsUseCases = createSettingsUseCases(container);
  // Jeton de requête : le résultat d'un chargement dépassé par un plus récent est ignoré.
  let requestId = 0;

  return createStore<SomedayState>()((set, get) => ({
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,
    compact: false,
    editMode: false,
    selection: new Set<TaskId>(),

    async load() {
      const id = ++requestId;
      // Relecture silencieuse quand la liste est déjà affichée (pas de squelette ni de clignotement).
      set({ status: get().status === 'ready' ? 'ready' : 'loading', errorKey: null });
      try {
        const tasks = await container.data.repos.tasks.listSomeday('all');
        container.taskEntities.publish(tasks);
        // Un réglage illisible n'empêche pas l'affichage : vue normale.
        const compact = await container.data.repos.settings.get('view.compact').then((value) => value.someday, () => false);
        if (id === requestId) set({ status: 'ready', compact });
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
      if (!current) return false;
      try {
        // Le cas d'usage publie la tâche écrite dans la source unique : terminée, elle quitte la liste (`isInSomedayList`).
        if (current.status === 'done') await useCases.reopen(id);
        else await useCases.complete(id);
        set({ actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'tasks.completeError' });
        return false;
      }
    },

    async schedule(ids, target) {
      try {
        await useCases.scheduleSomeday(ids, target);
        set({ actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'someday.planError' });
        return false;
      }
    },

    async setCompact(compact) {
      const previous = get().compact;
      set({ compact });
      try {
        await settingsUseCases.setCompactView('someday', compact);
      } catch {
        set({ compact: previous, actionErrorKey: 'tasks.detailSaveError' });
      }
    },

    setEditMode(active) {
      set({ editMode: active, selection: new Set<TaskId>() });
    },

    toggleSelection(id) {
      const next = new Set(get().selection);
      if (!next.delete(id)) next.add(id);
      set({ selection: next });
    },

    addToSelection(ids) {
      set({ selection: new Set([...get().selection, ...ids]) });
    },

    clearSelection() {
      if (get().selection.size > 0) set({ selection: new Set<TaskId>() });
    },

    async moveRow(rows, id, toIndex) {
      const outcome = moveTaskRow(rows, id, toIndex);
      if (!outcome) return null;
      if (outcome.changes.length === 0) return outcome;
      try {
        await useCases.reorder(outcome.changes.map((change) => ({ id: change.id as TaskId, sortOrder: change.sortOrder })));
        set({ actionErrorKey: null });
        return outcome;
      } catch {
        set({ actionErrorKey: 'today.reorderError' });
        return null;
      }
    },

    async scheduleSelected(ids, target) {
      if (ids.length === 0) return;
      try {
        await useCases.scheduleSomeday(ids, target);
        set({ actionErrorKey: null, selection: without(get().selection, ids) });
      } catch {
        set({ actionErrorKey: 'someday.planError' });
      }
    },

    async remove(ids) {
      if (ids.length === 0) return;
      try {
        await useCases.remove(ids);
        set({ actionErrorKey: null, selection: without(get().selection, ids) });
      } catch {
        set({ actionErrorKey: 'tasks.deleteError' });
      }
    },

    async moveToSpace(ids, spaceId, projectId) {
      if (ids.length === 0) return;
      try {
        await useCases.moveToSpace(ids, spaceId, projectId);
        set({ actionErrorKey: null, selection: without(get().selection, ids) });
      } catch {
        set({ actionErrorKey: 'today.moveError' });
      }
    },
  }));
});
