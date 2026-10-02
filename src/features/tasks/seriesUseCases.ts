import { todayLocal } from '../../domain/clock';
import type { Recurrence, RecurrenceFields, Task, TaskPatch } from '../../domain/model';
import {
  changedSeriesFields,
  DETACH_FROM_SERIES,
  divergedTemplate,
  seriesValuesPatch,
  type SeriesScope,
} from '../../domain/recurrenceEdit';
import { validateRecurrence } from '../../domain/recurrenceRules';
import { validateTaskTitle } from '../../domain/taskRules';
import { postponeTask, type PostponeTarget } from '../../domain/taskPostpone';
import { setTaskSchedule } from '../../domain/taskSchedule';
import type { RecurrenceId, Result, TaskId } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import { createNextOccurrence, type CreatedOccurrence } from './recurrenceUseCases';
import { createRemoveUndo, type RuleChange } from './undoCommands';
import type { TaskUseCaseDeps } from './taskUseCases';

/** Erreurs métier de la modification d'une série (T-10) ; les erreurs d'écriture rejettent. */
export type SeriesError =
  | 'not-found'
  | 'not-recurrent'
  | 'empty-title'
  | 'title-too-long'
  | 'needs-date'
  | 'invalid-schedule'
  | 'invalid-rule'
  | 'end-in-past'
  | 'end-before-start'
  | 'already-done'
  | 'invalid-date';

/**
 * Cas d'usage « série » (T-10) : modifier une occurrence, la règle, arrêter la répétition, supprimer une
 * occurrence. Chaque méthode est une transaction, publie dans `taskEntities` et pousse sa commande
 * d'annulation (critère 8). Contrat des choix : src/domain/recurrenceEdit.
 */
export interface SeriesUseCases {
  /**
   * Critères 1 à 3 : applique `patch` (titre, note, icône, heure, espace, projet, date) à l'occurrence.
   * `occurrence` : seule la tâche change, la suivante reprendra les valeurs de la série ; `following` :
   * la tâche et les occurrences futures déjà créées changent, la série reprend ces valeurs. Les
   * occurrences terminées ne sont jamais touchées. Annulable.
   */
  updateOccurrence(id: TaskId, patch: TaskPatch, scope: SeriesScope): Promise<Result<Task, SeriesError>>;
  /** Critères 4, 5, 9 : nouvelle règle (fréquence, jours, fin) pour « toutes les suivantes » ; rend la règle écrite. Annulable. */
  updateRule(id: TaskId, rule: RecurrenceFields): Promise<Result<RecurrenceFields, SeriesError>>;
  /**
   * Critère 4 (changement de date seul) : reporte l'occurrence (T-05 : date visée calculée depuis aujourd'hui, heure conservée)
   * pour « cette occurrence » (la série garde son ancre) ou « toutes les suivantes » (la série repart de la nouvelle date). Annulable.
   */
  postpone(id: TaskId, target: PostponeTarget, scope: SeriesScope): Promise<Result<Task, SeriesError>>;
  /** Critère 6 : l'occurrence devient une tâche simple, plus aucune suivante. Annulable. */
  stop(id: TaskId): Promise<Result<Task, SeriesError>>;
  /** Critère 7 (et T-08 critère 8) : corbeille de l'occurrence ; `occurrence` génère la suivante, `following` arrête la série. Annulable. */
  remove(id: TaskId, scope: SeriesScope): Promise<Result<Task, SeriesError>>;
}

/** Valeurs d'une tâche que l'annulation d'une modification de série remet. */
function restorePatch(task: Task): TaskPatch {
  return {
    title: task.title,
    note: task.note,
    icon: task.icon,
    time: task.time,
    spaceId: task.spaceId,
    projectId: task.projectId,
    date: task.date,
    someday: task.someday,
    carriedOver: task.carriedOver,
    recurrenceId: task.recurrenceId,
    seriesIndex: task.seriesIndex,
    seriesTemplate: task.seriesTemplate,
  };
}

interface Entry {
  readonly before: Task;
  readonly after: Task;
}


function ruleFieldsOf(rule: Recurrence): RecurrenceFields {
  const { freq, interval, weekdays, monthDay, nthWeekday, until, count } = rule;
  return { freq, interval, weekdays, monthDay, nthWeekday, until, count };
}

/** Occurrences à venir, déjà créées et à faire, qui suivent `task` dans sa série (« les suivantes »). */
async function laterTodoOccurrences(repos: Repositories, task: Task): Promise<Task[]> {
  if (task.recurrenceId === null) return [];
  const index = task.seriesIndex ?? 0;
  const siblings = await repos.tasks.listByRecurrence(task.recurrenceId);
  return siblings.filter((t) => t.id !== task.id && (t.seriesIndex ?? -1) > index && t.status === 'todo');
}

type MutableTaskPatch = { -readonly [K in keyof TaskPatch]: TaskPatch[K] };

export function createSeriesUseCases(deps: TaskUseCaseDeps): SeriesUseCases {
  /**
   * Annulation d'une réécriture (modification, règle, arrêt) : seules les tâches et la règle inchangées
   * depuis (hlc identique) sont remises ; rien de remis : 'stale'.
   */
  async function undoChange(entries: readonly Entry[], rule?: RuleChange & { readonly deleted: boolean }) {
    const outcome = await deps.data.transaction(async (repos) => {
      const written: Task[] = [];
      for (const { before, after } of entries) {
        const current = await repos.tasks.getById(after.id);
        if (!current || current.hlc !== after.hlc) continue;
        written.push(await repos.tasks.update(before.id, restorePatch(before)));
      }
      let ruleDone = false;
      if (rule) {
        const stored = await repos.recurrences.getById(rule.after.id, { includeDeleted: true });
        if (stored && stored.hlc === rule.after.hlc) {
          if (rule.deleted) await repos.recurrences.restore(rule.after.id);
          else await repos.recurrences.update(rule.before.id, ruleFieldsOf(rule.before));
          ruleDone = true;
        }
      }
      return { written, ruleDone };
    });
    if (outcome.written.length === 0 && !outcome.ruleDone) return 'stale' as const;
    deps.taskEntities.publish(outcome.written);
    return 'undone' as const;
  }

  const api: SeriesUseCases = {
    async updateOccurrence(id, patch, scope) {
      const result = await deps.data.transaction(async (repos): Promise<Result<readonly Entry[], SeriesError>> => {
        const current = await repos.tasks.getById(id);
        if (!current) return { ok: false, error: 'not-found' };
        if (current.recurrenceId === null) return { ok: false, error: 'not-recurrent' };

        const write: MutableTaskPatch = {};
        if (patch.title !== undefined) {
          const title = validateTaskTitle(patch.title);
          if (!title.ok) return { ok: false, error: title.error };
          write.title = title.value;
        }
        if (patch.note !== undefined) write.note = patch.note;
        if (patch.icon !== undefined) write.icon = patch.icon;
        if (patch.spaceId !== undefined) write.spaceId = patch.spaceId;
        if (patch.projectId !== undefined) write.projectId = patch.projectId;
        if (patch.date !== undefined || patch.time !== undefined) {
          // Une occurrence garde une date (T-09 critère 5) ; l'heure suit les invariants de T-02.
          if (patch.date === null) return { ok: false, error: 'needs-date' };
          const scheduled = setTaskSchedule(
            { date: current.date, time: current.time, someday: current.someday },
            { ...(patch.date !== undefined ? { date: patch.date } : {}), ...(patch.time !== undefined ? { time: patch.time } : {}) },
          );
          if (!scheduled.ok) return { ok: false, error: 'invalid-schedule' };
          write.date = scheduled.value.date;
          write.time = scheduled.value.time;
        }

        if (changedSeriesFields(current, write).length === 0) return { ok: true, value: [{ before: current, after: current }] };
        if (write.date !== undefined && write.date !== current.date && current.carriedOver) write.carriedOver = false;
        write.seriesTemplate = scope === 'occurrence' ? divergedTemplate(current) : null;

        const entries: Entry[] = [{ before: current, after: await repos.tasks.update(id, write) }];
        if (scope === 'following') {
          const values = seriesValuesPatch(write);
          if (Object.keys(values).length > 0) {
            for (const later of await laterTodoOccurrences(repos, current)) {
              entries.push({ before: later, after: await repos.tasks.update(later.id, values) });
            }
          }
        }
        return { ok: true, value: entries };
      });
      if (!result.ok) return result;
      const [first] = result.value;
      if (!first) return { ok: false, error: 'not-found' };
      const changed = result.value.filter((e) => e.before.hlc !== e.after.hlc);
      if (changed.length === 0) return { ok: true, value: first.after };
      deps.taskEntities.publish(result.value.map((e) => e.after));
      deps.undo.push({
        kind: 'series',
        count: 1,
        labelKey: scope === 'occurrence' ? 'undo.seriesOccurrence' : 'undo.seriesFollowing',
        labelParams: { title: first.after.title },
        undo: () => undoChange(changed),
      });
      return { ok: true, value: first.after };
    },

    async postpone(id, target, scope) {
      const current = await deps.data.repos.tasks.getById(id);
      if (!current) return { ok: false, error: 'not-found' };
      if (current.recurrenceId === null) return { ok: false, error: 'not-recurrent' };
      const next = postponeTask(current, todayLocal(deps.clock), target);
      if (!next.ok) return { ok: false, error: next.error };
      if (next.value.date === null) return { ok: false, error: 'invalid-date' };
      return api.updateOccurrence(id, { date: next.value.date }, scope);
    },

    async updateRule(id, rule) {
      const outcome = await deps.data.transaction(async (repos): Promise<Result<RuleChange & { readonly task: Task }, SeriesError>> => {
        const current = await repos.tasks.getById(id);
        if (!current) return { ok: false, error: 'not-found' };
        const before = current.recurrenceId ? await repos.recurrences.getById(current.recurrenceId) : null;
        if (!before) return { ok: false, error: 'not-recurrent' };
        const checked = validateRecurrence(rule, { startDate: current.date, today: todayLocal(deps.clock) });
        if (!checked.ok) {
          const codes = checked.error.map((e) => e.code);
          if (codes.includes('until_in_past')) return { ok: false, error: 'end-in-past' };
          if (codes.includes('until_before_start')) return { ok: false, error: 'end-before-start' };
          return { ok: false, error: codes.includes('start_required') ? 'needs-date' : 'invalid-rule' };
        }
        const after = await repos.recurrences.update(before.id, checked.value);
        return { ok: true, value: { before, after, task: current } };
      });
      if (!outcome.ok) return outcome;
      const { before, after, task } = outcome.value;
      deps.undo.push({
        kind: 'series',
        count: 1,
        labelKey: 'undo.seriesRule',
        labelParams: { title: task.title },
        undo: () => undoChange([], { before, after, deleted: false }),
      });
      return { ok: true, value: ruleFieldsOf(after) };
    },

    async stop(id) {
      const outcome = await deps.data.transaction(async (repos): Promise<Result<{ entries: Entry[]; rule: RuleChange }, SeriesError>> => {
        const current = await repos.tasks.getById(id);
        if (!current) return { ok: false, error: 'not-found' };
        const before = current.recurrenceId ? await repos.recurrences.getById(current.recurrenceId) : null;
        if (!before) return { ok: false, error: 'not-recurrent' };
        const entries: Entry[] = [{ before: current, after: await repos.tasks.update(id, DETACH_FROM_SERIES) }];
        // Les occurrences à venir déjà créées ne se répètent plus non plus : elles deviennent des tâches simples.
        for (const later of await laterTodoOccurrences(repos, current)) {
          entries.push({ before: later, after: await repos.tasks.update(later.id, DETACH_FROM_SERIES) });
        }
        const after = await repos.recurrences.softDelete(before.id);
        return { ok: true, value: { entries, rule: { before, after } } };
      });
      if (!outcome.ok) return outcome;
      const { entries, rule } = outcome.value;
      const first = entries[0];
      if (!first) return { ok: false, error: 'not-found' };
      deps.taskEntities.publish(entries.map((e) => e.after));
      deps.undo.push({
        kind: 'series',
        count: 1,
        labelKey: 'undo.seriesStop',
        labelParams: { title: first.after.title },
        undo: () => undoChange(entries, { ...rule, deleted: true }),
      });
      return { ok: true, value: first.after };
    },

    async remove(id, scope) {
      const outcome = await deps.data.transaction(
        async (repos): Promise<Result<{ deleted: Task[]; next: CreatedOccurrence | null; rule: RuleChange | null }, SeriesError>> => {
          const current = await repos.tasks.getById(id);
          if (!current) return { ok: false, error: 'not-found' };
          const rid: RecurrenceId | null = current.recurrenceId;
          if (rid === null) return { ok: false, error: 'not-recurrent' };
          const softDelete = async (task: Task): Promise<Task | null> => {
            const [removed] = await repos.tasks.softDelete([task.id]);
            if (removed) await repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, removed.deletedAt ?? undefined);
            return removed ?? null;
          };
          const first = await softDelete(current);
          if (!first) return { ok: false, error: 'not-found' };
          const deleted = [first];
          if (scope === 'occurrence') {
            const next = await createNextOccurrence(deps, repos, current, todayLocal(deps.clock), { ignoreDue: true });
            return { ok: true, value: { deleted, next, rule: null } };
          }
          // « Toutes les suivantes » : la série s'arrête, les occurrences à venir déjà créées partent aussi.
          const before = await repos.recurrences.getById(rid);
          for (const later of await laterTodoOccurrences(repos, current)) {
            const removed = await softDelete(later);
            if (removed) deleted.push(removed);
          }
          const after = before ? await repos.recurrences.softDelete(rid) : null;
          return { ok: true, value: { deleted, next: null, rule: before && after ? { before, after } : null } };
        },
      );
      if (!outcome.ok) return outcome;
      const { deleted, next, rule } = outcome.value;
      const [first] = deleted;
      if (!first) return { ok: false, error: 'not-found' };
      deps.taskEntities.remove(deleted.map((t) => t.id));
      if (next) deps.taskEntities.publish([next.task]);
      deps.undo.push(createRemoveUndo(deps, deleted, next ? [next] : [], rule));
      return { ok: true, value: first };
    },
  };
  return api;
}
