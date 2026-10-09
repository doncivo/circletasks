import { createStore } from 'zustand';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, TaskPatch } from '../../domain/model';
import { validateTaskTitle } from '../../domain/taskRules';
import type { SeriesScope } from '../../domain/recurrenceEdit';
import type { LocalDate, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from './createTaskUseCases';
import { createSeriesUseCases, type SeriesError } from './seriesUseCases';

export type TaskDetailStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État et actions de la fiche détail d'une tâche (A-08), limité par T-03 aux
 * zones icône et note, plus le bouton terminer / rouvrir (T-04). Une instance par
 * conteneur (`defineFeatureStore`, ADR 0004). La tâche affichée n'est PAS copiée
 * ici : seul `taskId` est gardé, l'entité est lue dans `container.taskEntities`
 * (ADR 0004, avenant « Source unique des tâches chargées »).
 */
export interface TaskDetailState {
  readonly taskId: TaskId | null;
  /** Règle de récurrence de la tâche affichée (T-09), `null` : une fois ou pas encore lue. */
  readonly recurrence: RecurrenceFields | null;
  /** Avances des rappels de la tâche (M5), lues pour la fiche ; l'édition revient à N-02. */
  readonly reminders: readonly ReminderOffsetMin[];
  readonly status: TaskDetailStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error' ; `null` sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** Charge la tâche `id` (publiée dans `taskEntities`) pour la fiche. Ne rejette jamais. */
  load(id: TaskId): Promise<void>;
  /**
   * Modifie des champs de la tâche (titre, date, heure, « Un jour », espace…) depuis la fiche (A-08, critère 8) ; titre vidé ou
   * trop long refusé (T-01). Rend true si écrit. Ne rejette jamais ; `errorKey` pose le message.
   */
  updateFields(patch: TaskPatch): Promise<boolean>;
  /**
   * N-02 : remplace les rappels de la tâche affichée par ces avances (lignes ajoutées / supprimées logiquement). Rend true si
   * enregistrés ; sans heure, refusé. Aucune notification n'est planifiée (ordre 5). Ne rejette jamais.
   */
  setReminders(offsets: readonly ReminderOffsetMin[]): Promise<boolean>;
  /** N-02 : feuille « Modifier » : champs et rappels en une transaction. Rend true si écrit. Ne rejette jamais. */
  updateFieldsAndReminders(patch: TaskPatch, offsets: readonly ReminderOffsetMin[]): Promise<boolean>;
  /** Bouton « Un jour » (A-08, SD-03) : date et heure retirées ; annulable. Rend true si rangée. Ne rejette jamais. */
  moveToSomeday(): Promise<boolean>;
  /** Enregistre la note à la perte de focus (critères 7 à 9). Ne rejette jamais. */
  updateNote(note: string): Promise<void>;
  /** Change ou retire (`null`) l'icône depuis la pastille (critère 5). Ne rejette jamais. */
  updateIcon(icon: IconRef | null): Promise<void>;
  /**
   * Bouton « Marquer comme terminée » (T-04, critère 1) : bascule selon le statut
   * courant de la tâche affichée. Ne rejette jamais.
   */
  toggleDone(): Promise<void>;
  /** Bouton « Reporter » / « Planifier » (T-05) : annulable, la fiche reste ouverte. Ne rejette jamais. */
  postpone(target: PostponeTarget): Promise<void>;
  /** T-12 : duplique la tâche affichée à `date` (null : « Un jour ») ; annulable, la fiche reste sur l'original. Rend true si créée. Ne rejette jamais. */
  duplicate(date: LocalDate | null): Promise<boolean>;
  /** T-10 critère 4 : reporte une occurrence récurrente pour « cette occurrence » ou « toutes les suivantes » ; annulable. Ne rejette jamais. */
  postponeSeries(target: PostponeTarget, scope: SeriesScope): Promise<void>;
  /**
   * T-09 : rend la tâche affichée récurrente (aucune règle n'existait). Rend true si la règle est
   * posée (la fiche la reflète via `taskEntities`), false sinon (message dédié). Ne rejette jamais.
   */
  setRecurrence(rule: RecurrenceFields): Promise<boolean>;
  /**
   * Supprime la tâche affichée (T-08, après confirmation par la fiche) : corbeille, annulable 5 s.
   * Rend true si elle est supprimée (la fiche doit se fermer), false en cas d'échec (message dédié,
   * la tâche reste affichée). Ne rejette jamais.
   */
  remove(scope?: SeriesScope): Promise<boolean>;
  /**
   * T-10 critères 1 à 3 : applique `patch` (note, icône…) à l'occurrence affichée, pour « cette occurrence »
   * ou « toutes les suivantes » (choisi par la fiche). Rend true si écrit. Annulable. Ne rejette jamais.
   */
  applySeriesEdit(patch: TaskPatch, scope: SeriesScope): Promise<boolean>;
  /** T-10 critères 4, 5, 9 : nouvelle règle (fréquence, jours, fin) pour « toutes les suivantes ». Rend true si écrite. Ne rejette jamais. */
  updateRecurrence(rule: RecurrenceFields): Promise<boolean>;
  /** T-10 critère 6 : « Arrêter la répétition » ; la tâche devient simple. Rend true si arrêtée. Ne rejette jamais. */
  stopRecurrence(): Promise<boolean>;
  /** Relit la règle de la série (après une annulation, T-10 critère 8). Ne rejette jamais. */
  refreshRecurrence(): Promise<void>;
}

/** Message de l'erreur métier d'une modification de série (T-10, critère 9 : fin dépassée). */
function seriesErrorKey(error: SeriesError): PlainMessageKey {
  switch (error) {
    case 'end-in-past':
      return 'tasks.seriesEndInPast';
    case 'end-before-start':
      return 'tasks.seriesEndBeforeStart';
    case 'empty-title':
    case 'title-too-long':
      return 'tasks.seriesTitleInvalid';
    default:
      return 'tasks.seriesError';
  }
}

export const taskDetailStore = defineFeatureStore<TaskDetailState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  const series = createSeriesUseCases(container);
  // Jeton de requête : ignore une réponse périmée (chargement ou écriture plus
  // ancienne qui se termine après un appel plus récent, même principe que todayStore).
  let requestId = 0;

  async function run(
    set: (partial: Partial<TaskDetailState>) => void,
    get: () => TaskDetailState,
    action: (taskId: TaskId) => Promise<unknown>,
  ): Promise<void> {
    const { taskId } = get();
    if (!taskId) return;
    const id = ++requestId;
    try {
      await action(taskId); // le cas d'usage publie la tâche écrite dans `taskEntities`
      if (id !== requestId) return; // un chargement ou une écriture plus récente a pris le dessus
      set({ status: 'ready', errorKey: null });
    } catch {
      if (id !== requestId) return;
      set({ status: 'error', errorKey: 'tasks.detailSaveError' });
    }
  }

  return createStore<TaskDetailState>()((set, get) => ({
    taskId: null,
    recurrence: null,
    reminders: [],
    status: 'idle',
    errorKey: null,

    async load(id) {
      const requestedId = ++requestId;
      set({ taskId: id, recurrence: null, reminders: [], status: 'loading', errorKey: null });
      try {
        const task = await container.data.repos.tasks.getById(id);
        if (requestedId !== requestId) return;
        if (!task) {
          set({ status: 'error', errorKey: 'tasks.detailLoadError' });
          return;
        }
        container.taskEntities.publish([task]);
        // Règle de la série (T-09) : sa lecture ne bloque pas l'affichage de la fiche.
        const recurrence = task.recurrenceId ? await container.data.repos.recurrences.getById(task.recurrenceId).catch(() => null) : null;
        if (requestedId !== requestId) return;
        // Rappels : affichage seulement, leur lecture ne bloque pas la fiche (l'objectif est lu par l'interrupteur d'objectif, OB-03).
        const reminders = await container.data.repos.reminders.listForTarget({ type: 'task', id }).then((rows) => rows.map((row) => row.offsetMin), () => []);
        if (requestedId !== requestId) return;
        set({ status: 'ready', errorKey: null, recurrence, reminders });
      } catch {
        if (requestedId !== requestId) return;
        set({ status: 'error', errorKey: 'tasks.detailLoadError' });
      }
    },

    async updateFields(patch) {
      const { taskId } = get();
      if (!taskId) return false;
      const write = { ...patch };
      if (patch.title !== undefined) {
        const title = validateTaskTitle(patch.title);
        if (!title.ok) {
          set({ status: 'error', errorKey: 'detail.titleRequired' });
          return false;
        }
        write.title = title.value;
      }
      try {
        // ES-05 : un changement d'espace ou de projet est un déplacement (message « déplacée dans Perso », annulable, Ctrl+Z) ;
        // les autres champs s'écrivent à part. Un projet n'est valable que dans son espace (aucun projet si l'espace change).
        const { spaceId, projectId, ...rest } = write;
        if (Object.keys(rest).length > 0 || (spaceId === undefined && projectId === undefined)) await useCases.update(taskId, rest);
        if (spaceId !== undefined || projectId !== undefined) {
          const current = await container.data.repos.tasks.getById(taskId);
          if (current) {
            const space = spaceId ?? current.spaceId;
            const project = projectId !== undefined ? projectId : space === current.spaceId ? current.projectId : null;
            await useCases.moveToSpace([taskId], space, project);
          }
        }
        set({ status: 'ready', errorKey: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.detailSaveError' });
        return false;
      }
    },

    async setReminders(offsets) {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await useCases.setReminders(taskId, offsets);
        if (!result.ok) {
          set({ status: 'error', errorKey: 'reminders.saveError' });
          return false;
        }
        set({ status: 'ready', errorKey: null, reminders: result.value });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'reminders.saveError' });
        return false;
      }
    },

    async updateFieldsAndReminders(patch, offsets) {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await useCases.updateWithReminders(taskId, patch, offsets);
        if (!result.ok) {
          set({ status: 'error', errorKey: 'reminders.saveError' });
          return false;
        }
        const rows = await container.data.repos.reminders.listForTarget({ type: 'task', id: taskId });
        set({ status: 'ready', errorKey: null, reminders: rows.map((row) => row.offsetMin) });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.detailSaveError' });
        return false;
      }
    },

    async moveToSomeday() {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const moved = await useCases.moveToSomeday([taskId]);
        set({ status: 'ready', errorKey: null });
        return moved.length > 0;
      } catch {
        set({ status: 'error', errorKey: 'detail.somedayError' });
        return false;
      }
    },

    updateNote: (note) => run(set, get, (id) => useCases.update(id, { note })),
    updateIcon: (icon) => run(set, get, (id) => useCases.update(id, { icon })),

    postpone: async (target) => {
      const { taskId } = get();
      if (!taskId) return;
      try {
        await useCases.postpone([taskId], target);
        set({ errorKey: null });
      } catch {
        set({ status: 'error', errorKey: 'tasks.postponeError' });
      }
    },

    postponeSeries: async (target, scope) => {
      const { taskId } = get();
      if (!taskId) return;
      try {
        const result = await series.postpone(taskId, target, scope);
        if (!result.ok) {
          set({ status: 'error', errorKey: 'tasks.postponeError' });
          return;
        }
        set({ errorKey: null });
      } catch {
        set({ status: 'error', errorKey: 'tasks.postponeError' });
      }
    },

    duplicate: async (date) => {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        await useCases.duplicate(taskId, date);
        set({ errorKey: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.duplicateError' });
        return false;
      }
    },

    setRecurrence: async (rule) => {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await useCases.setRecurrence(taskId, rule);
        if (!result.ok) {
          set({ status: 'error', errorKey: result.error === 'invalid' || result.error === 'needs-date' ? 'tasks.repeatInvalid' : result.error === 'apple-linked' ? 'appleReminders.noRepeat' : 'tasks.repeatError' });
          return false;
        }
        set({ status: 'ready', errorKey: null, recurrence: rule });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.repeatError' });
        return false;
      }
    },

    remove: async (scope) => {
      const { taskId } = get();
      if (!taskId) return false;
      // Une écriture ou un chargement plus ancien ne doit pas écraser l'état après la suppression.
      requestId += 1;
      try {
        if (scope) {
          const result = await series.remove(taskId, scope);
          if (!result.ok) {
            set({ status: 'error', errorKey: 'tasks.deleteError' });
            return false;
          }
        } else await useCases.remove([taskId]); // retire la tâche de `taskEntities` : toutes les vues la perdent
        set({ taskId: null, status: 'idle', errorKey: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.deleteError' });
        return false;
      }
    },

    applySeriesEdit: async (patch, scope) => {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await series.updateOccurrence(taskId, patch, scope);
        if (!result.ok) {
          set({ status: 'error', errorKey: seriesErrorKey(result.error) });
          return false;
        }
        set({ status: 'ready', errorKey: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.detailSaveError' });
        return false;
      }
    },

    updateRecurrence: async (rule) => {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await series.updateRule(taskId, rule);
        if (!result.ok) {
          set({ status: 'error', errorKey: seriesErrorKey(result.error) });
          return false;
        }
        set({ status: 'ready', errorKey: null, recurrence: result.value });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.seriesError' });
        return false;
      }
    },

    stopRecurrence: async () => {
      const { taskId } = get();
      if (!taskId) return false;
      try {
        const result = await series.stop(taskId);
        if (!result.ok) {
          set({ status: 'error', errorKey: seriesErrorKey(result.error) });
          return false;
        }
        set({ status: 'ready', errorKey: null, recurrence: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.seriesError' });
        return false;
      }
    },

    refreshRecurrence: async () => {
      const { taskId } = get();
      if (!taskId) return;
      try {
        const task = container.taskEntities.get(taskId);
        const recurrence = task?.recurrenceId ? await container.data.repos.recurrences.getById(task.recurrenceId) : null;
        if (get().taskId === taskId) set({ recurrence });
      } catch {
        // la fiche garde la règle affichée ; la prochaine ouverture la relit
      }
    },

    toggleDone: () =>
      run(set, get, (id) => {
        // Statut lu dans la source unique : une tâche déjà terminée depuis la liste
        // n'est pas terminée une seconde fois (`complete` est de toute façon idempotent).
        const current = container.taskEntities.get(id);
        return current?.status === 'done' ? useCases.reopen(id) : useCases.complete(id);
      }),
  }));
});
