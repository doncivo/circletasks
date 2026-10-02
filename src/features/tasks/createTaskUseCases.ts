import { nowIso, todayLocal } from '../../domain/clock';
import { newEntityId } from '../../domain/id';
import type { NewRecurrence, NewTask, RecurrenceFields, ReminderOffsetMin, Task, TaskPatch } from '../../domain/model';
import { duplicateTask } from '../../domain/taskDuplicate';
import { buildReminders, canHaveReminders, sortReminderOffsets } from '../../domain/reminders';
import { syncTaskReminders } from './reminderSync';
import { moveTaskToDate } from '../../domain/taskMove';
import { divergedTemplate } from '../../domain/recurrenceEdit';
import { validateRecurrence } from '../../domain/recurrenceRules';
import { completeTask, isCompleted } from '../../domain/taskCompletion';
import { nextDayFrom, postponeTask, resolvePostponeDate } from '../../domain/taskPostpone';
import { validateTaskTitle } from '../../domain/taskRules';
import { canMoveToSomeday, ScheduleInvariantError, scheduleOf, setTaskSchedule } from '../../domain/taskSchedule';
import type { LocalDate, RecurrenceId, ReminderId, Result, TaskId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { RepositoryError } from '../../db/repositories';
import type { UndoableCommand } from '../app/undo';
import { createNextOccurrence, type CreatedOccurrence } from './recurrenceUseCases';
import {
  createCompleteUndoCommand,
  createDeleteUndoCommand,
  createDuplicateUndoCommand,
  createMoveDayUndoCommand,
  createMoveUndoCommand,
  createPostponeUndoCommand,
  createRemoveUndo,
  createReorderUndoCommand,
  type PostponedEntry,
} from './undoCommands';
import type { CreateTaskError, SetRecurrenceError, SetRemindersError, TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

/** Le patch touche-t-il la planification (date, heure, « Un jour ») ? */
function touchesSchedule(patch: TaskPatch): boolean {
  return patch.date !== undefined || patch.time !== undefined || patch.someday !== undefined;
}

/**
 * Implémentation des cas d'usage « tâches » (contrat : `./taskUseCases.ts`, ADR 0004).
 *
 * T-01 livre `create` seul : les autres méthodes sont posées par leur story
 * (commentaires du contrat) et lèvent `NotImplementedError` d'ici là, sur le même
 * modèle que `createPendingRepositories` (ADR 0004).
 */
export function createTaskUseCases(deps: TaskUseCaseDeps): TaskUseCases {
  return {
    async create(input): Promise<Result<Task, CreateTaskError>> {
      const titleResult = validateTaskTitle(input.title);
      if (!titleResult.ok) return titleResult;

      const someday = input.someday ?? false;
      // Absent : aujourd'hui (T-01) ; null avec someday : tâche « Un jour » (SD-01).
      const date = someday ? null : (input.date !== undefined ? input.date : todayLocal(deps.clock));
      const time = input.time ?? null;
      if (time && !date) return { ok: false, error: 'time-without-date' };

      // T-09 critère 5 : une récurrence exige une date de départ (règle validée par src/domain).
      let recurrence: RecurrenceFields | null = null;
      if (input.recurrence) {
        const checked = validateRecurrence(input.recurrence, { startDate: date });
        if (!checked.ok) return { ok: false, error: checked.error.some((e) => e.code === 'start_required') ? 'recurrence-needs-date' : 'recurrence-invalid' };
        recurrence = checked.value;
      }

      const newTask: NewTask = {
        id: newEntityId<TaskId>(deps.ids),
        spaceId: input.spaceId,
        projectId: input.projectId ?? null,
        title: titleResult.value,
        note: input.note ?? '',
        date,
        time,
        status: 'todo',
        doneAt: null,
        // Ordre manuel réel posé par A-02 ; une création s'ajoute à la fin par
        // horodatage croissant, en attendant l'algorithme d'insertion par milieu.
        sortOrder: deps.clock.nowMs(),
        carriedOver: false,
        recurrenceId: null,
        seriesIndex: null,
        seriesTemplate: null,
        goalId: input.goalId ?? null,
        icon: input.icon ?? null,
        someday,
        source: 'local',
        externalId: null,
      };
      // N-02 : une ligne `reminder` par avance choisie, seulement si la tâche a une date et une heure (QB-07).
      const reminders = buildReminders({
        target: { type: 'task', id: newTask.id },
        date,
        time,
        offsets: input.reminderOffsets ?? [],
        newReminderId: () => newEntityId<ReminderId>(deps.ids),
      });
      // Récurrence, tâche et rappels en une transaction (T-09) : la première occurrence a l'indice 0.
      const created =
        recurrence || reminders.length > 0
          ? await deps.data.transaction(async (repos) => {
              const rule = recurrence ? await repos.recurrences.create({ ...recurrence, id: newEntityId<RecurrenceId>(deps.ids) } satisfies NewRecurrence) : null;
              const task = await repos.tasks.create(rule ? { ...newTask, recurrenceId: rule.id, seriesIndex: 0 } : newTask);
              if (reminders.length > 0) await repos.reminders.replaceForTarget({ type: 'task', id: task.id }, reminders);
              return task;
            })
          : await deps.data.repos.tasks.create(newTask);
      deps.taskEntities.publish([created]);
      return { ok: true, value: created };
    },

    async setReminders(id: TaskId, offsets): Promise<Result<ReminderOffsetMin[], SetRemindersError>> {
      return deps.data.transaction(async (repos): Promise<Result<ReminderOffsetMin[], SetRemindersError>> => {
        const task = await repos.tasks.getById(id);
        if (!task) return { ok: false, error: 'not-found' };
        const target = { type: 'task', id } as const;
        const wanted = sortReminderOffsets(offsets);
        if (wanted.length === 0) {
          await repos.reminders.replaceForTarget(target, []);
          return { ok: true, value: [] };
        }
        if (!canHaveReminders(task)) return { ok: false, error: 'needs-time' };
        const rows = buildReminders({ target, date: task.date, time: task.time, offsets: wanted, newReminderId: () => newEntityId<ReminderId>(deps.ids) });
        const written = await repos.reminders.replaceForTarget(target, rows);
        return { ok: true, value: sortReminderOffsets(written.map((row) => row.offsetMin)) };
      });
    },

    async setRecurrence(id: TaskId, rule: RecurrenceFields): Promise<Result<Task, SetRecurrenceError>> {
      const written = await deps.data.transaction(async (repos): Promise<Result<Task, SetRecurrenceError>> => {
        const current = await repos.tasks.getById(id);
        if (!current) return { ok: false, error: 'not-found' };
        // Modifier ou arrêter une règle existante : T-10.
        if (current.recurrenceId !== null) return { ok: false, error: 'already-recurrent' };
        const checked = validateRecurrence(rule, { startDate: current.date });
        if (!checked.ok) return { ok: false, error: checked.error.some((e) => e.code === 'start_required') ? 'needs-date' : 'invalid' };
        const created = await repos.recurrences.create({ ...checked.value, id: newEntityId<RecurrenceId>(deps.ids) });
        return { ok: true, value: await repos.tasks.update(id, { recurrenceId: created.id, seriesIndex: 0 }) };
      });
      if (written.ok) deps.taskEntities.publish([written.value]);
      return written;
    },

    async update(id: TaskId, patch: TaskPatch): Promise<Task> {
      // T-02 : date, heure et « Un jour » passent par les invariants de
      // src/domain avant d'atteindre le repository (ADR 0004, règle 6 de
      // db/repositories/common.ts : aucune règle métier côté repository).
      // Les autres champs du patch (titre, note, icône…) sont posés par T-03 /
      // A-08, transmis tels quels ici : `update` reste le point d'entrée unique
      // de la fiche détail (commentaire de `TaskRepository.update`).
      const write = async (changes: TaskPatch): Promise<Task> => {
        // N-02 critère 5 : date ou heure changées, `fire_at` des rappels recalculé dans la même transaction.
        const written = touchesSchedule(changes)
          ? await deps.data.transaction(async (repos) => {
              const task = await repos.tasks.update(id, changes);
              await syncTaskReminders(repos, task);
              return task;
            })
          : await deps.data.repos.tasks.update(id, changes);
        deps.taskEntities.publish([written]);
        return written;
      };
      if (!touchesSchedule(patch)) {
        return write(patch);
      }
      const current = await deps.data.repos.tasks.getById(id);
      if (!current) return write(patch); // laisse le repository lever RepositoryError('not-found')

      // `exactOptionalPropertyTypes` (tsconfig) distingue « champ absent » de
      // « champ présent valant undefined » : on n'inclut une clé que si `patch`
      // la fournit réellement, pour ne pas écraser l'état courant par erreur.
      const scheduled = setTaskSchedule(scheduleOf(current), {
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.time !== undefined ? { time: patch.time } : {}),
        ...(patch.someday !== undefined ? { someday: patch.someday } : {}),
      });
      if (!scheduled.ok) throw new ScheduleInvariantError(scheduled.error);

      // T-06 critère 4 : changer la date efface le badge « reportée ».
      const dateChanged = scheduled.value.date !== current.date || scheduled.value.someday !== current.someday;
      return write({ ...patch, ...scheduled.value, ...(dateChanged && current.carriedOver ? { carriedOver: false } : {}) });
    },
    async complete(id: TaskId): Promise<Task> {
      // Invariant status ⇔ doneAt posé par src/domain (T-04) ; le repository ne
      // fait qu'écrire les deux colonnes ensemble (règle commune n°6).
      const current = await deps.data.repos.tasks.getById(id);
      // Idempotent (domaine) : déjà terminée, rien à écrire ni à annuler.
      if (current && isCompleted(current)) {
        deps.taskEntities.publish([current]);
        return current;
      }
      const { doneAt } = completeTask(current ?? { status: 'todo', doneAt: null }, nowIso(deps.clock));
      // T-06 critère 4 : terminer une tâche reportée efface son badge (même transaction).
      // T-09 : l'occurrence suivante d'une récurrence est créée dans la même transaction.
      const { updated, next } =
        current?.carriedOver || current?.recurrenceId
          ? await deps.data.transaction(async (repos) => {
              let done = await repos.tasks.complete(id, doneAt);
              if (current.carriedOver) done = await repos.tasks.update(id, { carriedOver: false });
              const created = done.recurrenceId ? await createNextOccurrence(deps, repos, done, todayLocal(deps.clock)) : null;
              return { updated: done, next: created };
            })
          : { updated: await deps.data.repos.tasks.complete(id, doneAt), next: null };
      deps.taskEntities.publish(next ? [updated, next.task] : [updated]);

      deps.undo.push(createCompleteUndoCommand(deps, updated, current?.carriedOver ?? false, next));
      return updated;
    },
    async reopen(id: TaskId): Promise<Task> {
      // Rouvrir une tâche terminée n'est pas annulable (contrat `TaskUseCases.reopen`) :
      // décocher une tâche terminée est déjà, du point de vue utilisateur,
      // l'annulation de la complétion précédente (critère 5).
      const reopened = await deps.data.repos.tasks.reopen(id);
      deps.taskEntities.publish([reopened]);
      return reopened;
    },
    async postpone(ids, target): Promise<Task[]> {
      // Q4 : tout se calcule depuis aujourd'hui (src/domain/taskPostpone) ; l'heure est conservée.
      const today = todayLocal(deps.clock);
      const resolved = resolvePostponeDate(today, target);
      if (!resolved.ok) throw new RangeError('Date de report invalide');
      const entries = await deps.data.transaction(async (repos) => {
        const done: PostponedEntry[] = [];
        for (const id of ids) {
          const before = await repos.tasks.getById(id);
          if (!before) continue;
          const next = postponeTask(before, today, target);
          // Terminée : ignorée (critère 9). Planification inchangée : rien à écrire ni à annuler.
          if (!next.ok || (next.value.date === before.date && next.value.time === before.time && !before.someday)) continue;
          // Un report manuel efface le badge « reportée » (T-06 critère 4) ; il ne le pose jamais.
          // Occurrence récurrente reportée sans choix (lot, appel direct) : « cette occurrence », la série garde son ancre (T-10).
          const diverge = before.recurrenceId !== null && before.seriesTemplate === null ? { seriesTemplate: divergedTemplate(before) } : {};
          const after = await repos.tasks.update(id, { ...next.value, carriedOver: false, ...diverge });
          await syncTaskReminders(repos, after);
          done.push({ before, after });
        }
        return done;
      });
      if (entries.length === 0) return [];
      const tasks = entries.map((entry) => entry.after);
      deps.taskEntities.publish(tasks);
      const first = entries[0];
      const label: Pick<UndoableCommand, 'labelKey' | 'labelParams'> =
        entries.length > 1 || !first
          ? {}
          : resolved.value === nextDayFrom(today)
            ? { labelKey: 'undo.postponeTomorrow', labelParams: { title: first.before.title } }
            : { labelKey: 'undo.postponeDate', labelParams: { title: first.before.title, date: formatDayLabel(resolved.value) } };
      deps.undo.push(createPostponeUndoCommand(deps, entries, label));
      return tasks;
    },
    async moveToDay(id, date): Promise<Task> {
      // S-02, S-06 : seule la date change (domaine `moveTaskToDate`) ; la tâche prend la fin de l'ordre manuel du jour d'arrivée.
      // Une occurrence récurrente déplacée garde les valeurs de la série pour la suivante (« cette occurrence », T-10).
      const { before, after } = await deps.data.transaction(async (repos) => {
        const current = await repos.tasks.getById(id);
        if (!current) throw new RepositoryError('not-found', 'task', id);
        const siblings = await repos.tasks.listForDay(date, 'all');
        const last = siblings.reduce<number | null>((max, other) => (other.id === id || (max !== null && other.sortOrder <= max) ? max : other.sortOrder), null);
        const moved = moveTaskToDate(current, date, last);
        if (!moved.ok) {
          if (moved.error === 'same-day') return { before: current, after: current };
          throw new RangeError('Date de déplacement invalide');
        }
        const diverge = current.recurrenceId !== null && current.status === 'todo' && current.seriesTemplate === null ? { seriesTemplate: divergedTemplate(current) } : {};
        const moved2 = await repos.tasks.update(id, { ...moved.value, ...diverge });
        await syncTaskReminders(repos, moved2);
        return { before: current, after: moved2 };
      });
      deps.taskEntities.publish([after]);
      if (after !== before) deps.undo.push(createMoveDayUndoCommand(deps, before, after, formatDayLabel(date)));
      return after;
    },
    async moveToSpace(ids, spaceId, projectId): Promise<Task[]> {
      const entries = await deps.data.transaction(async (repos) => {
        const done: PostponedEntry[] = [];
        for (const id of ids) {
          const before = await repos.tasks.getById(id);
          if (!before || (before.spaceId === spaceId && before.projectId === projectId)) continue;
          const [moved] = await repos.tasks.moveToSpace([id], spaceId, projectId);
          if (!moved) continue;
          // Occurrence récurrente : la série garde son espace d'origine (T-10), comme pour un report « cette occurrence ».
          const after =
            before.recurrenceId !== null && before.seriesTemplate === null
              ? await repos.tasks.update(id, { seriesTemplate: divergedTemplate(before) })
              : moved;
          done.push({ before, after });
        }
        return done;
      });
      if (entries.length === 0) return [];
      const tasks = entries.map((entry) => entry.after);
      deps.taskEntities.publish(tasks);
      deps.undo.push(createMoveUndoCommand(deps, entries));
      return tasks;
    },
    async moveToSomeday(ids): Promise<Task[]> {
      // Bouton « Un jour » de la fiche (A-08), SD-03 : date et heure retirées ; règle `canMoveToSomeday` (domaine).
      const entries = await deps.data.transaction(async (repos) => {
        const done: PostponedEntry[] = [];
        for (const id of ids) {
          const before = await repos.tasks.getById(id);
          if (!before || !canMoveToSomeday(before)) continue;
          const [after] = await repos.tasks.moveToSomeday([id]);
          if (after) done.push({ before, after });
        }
        return done;
      });
      if (entries.length === 0) return [];
      const tasks = entries.map((entry) => entry.after);
      deps.taskEntities.publish(tasks);
      const first = entries[0];
      deps.undo.push(
        createPostponeUndoCommand(deps, entries, entries.length === 1 && first ? { labelParams: { title: first.before.title } } : {}, 'someday'),
      );
      return tasks;
    },
    async duplicate(id: TaskId, date: LocalDate | null): Promise<Task> {
      // T-12 : copie titre, note, icône, espace, projet, heure et rappels (même avance) ; une transaction.
      const copy = await deps.data.transaction(async (repos) => {
        const source = await repos.tasks.getById(id);
        if (!source) throw new RepositoryError('not-found', 'task', id);
        const offsets = (await repos.reminders.listForTarget({ type: 'task', id })).map((r) => r.offsetMin);
        const built = duplicateTask(source, {
          taskId: newEntityId<TaskId>(deps.ids),
          date,
          reminderOffsets: offsets,
          newReminderId: () => newEntityId<ReminderId>(deps.ids),
          // Fin de liste du jour (même règle que la création, en attendant l'insertion par milieu d'A-02).
          sortOrder: deps.clock.nowMs(),
        });
        const created = await repos.tasks.create(built.task);
        if (built.reminders.length > 0) await repos.reminders.replaceForTarget({ type: 'task', id: created.id }, built.reminders);
        return created;
      });
      deps.taskEntities.publish([copy]);
      deps.undo.push(createDuplicateUndoCommand(deps, copy));
      return copy;
    },
    async remove(ids, options): Promise<Task[]> {
      // T-08 : suppression logique (deleted_at) + rappels de la tâche rendus inactifs, en une transaction.
      // `continueSeries` (lot, A-05) : une occurrence récurrente supprimée sans choix est traitée comme « cette
      // occurrence » : la suivante est créée, la série continue (« toutes les suivantes » : `series.remove`, T-10).
      const { deleted, nexts } = await deps.data.transaction(async (repos) => {
        const done: Task[] = [];
        const created: CreatedOccurrence[] = [];
        for (const id of ids) {
          const before = await repos.tasks.getById(id);
          if (!before) continue; // déjà supprimée ou inconnue : rien à faire
          const [task] = await repos.tasks.softDelete([id]);
          if (!task) continue;
          // Même deleted_at que la tâche : la restauration ne réactive que les rappels supprimés avec elle.
          await repos.reminders.softDeleteForTarget({ type: 'task', id }, task.deletedAt ?? undefined);
          done.push(task);
          if (options?.continueSeries && before.recurrenceId !== null) {
            const next = await createNextOccurrence(deps, repos, before, todayLocal(deps.clock), { ignoreDue: true });
            if (next) created.push(next);
          }
        }
        return { deleted: done, nexts: created };
      });
      if (deleted.length === 0) return [];
      // Source unique : la tâche disparaît de toutes les vues (Aujourd'hui, Terminées, fiche…).
      deps.taskEntities.remove(deleted.map((task) => task.id));
      if (nexts.length > 0) deps.taskEntities.publish(nexts.map((next) => next.task));
      deps.undo.push(nexts.length > 0 ? createRemoveUndo(deps, deleted, nexts, null) : createDeleteUndoCommand(deps, deleted));
      return deleted;
    },
    async reorder(entries): Promise<void> {
      if (entries.length === 0) return;
      // A-02 : ordre manuel écrit en une transaction ; la tâche relue porte le hlc de l'écriture (annulation, T-13).
      const moved = await deps.data.transaction(async (repos) => {
        const done: PostponedEntry[] = [];
        const before = new Map<TaskId, Task>();
        for (const entry of entries) {
          const task = await repos.tasks.getById(entry.id);
          if (task) before.set(task.id, task);
        }
        await repos.tasks.setSortOrders(entries.filter((entry) => before.has(entry.id)));
        for (const [id, previous] of before) {
          const after = await repos.tasks.getById(id);
          if (after) done.push({ before: previous, after });
        }
        return done;
      });
      if (moved.length === 0) return;
      deps.taskEntities.publish(moved.map((entry) => entry.after));
      deps.undo.push(createReorderUndoCommand(deps, moved));
    },
  };
}
