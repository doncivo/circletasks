import { nowIso, todayLocal } from '../../domain/clock';
import { newEntityId } from '../../domain/id';
import type { NewRecurrence, NewTask, RecurrenceFields, Task, TaskPatch } from '../../domain/model';
import { divergedTemplate } from '../../domain/recurrenceEdit';
import { validateRecurrence } from '../../domain/recurrenceRules';
import { completeTask, isCompleted } from '../../domain/taskCompletion';
import { nextDayFrom, postponeTask, resolvePostponeDate } from '../../domain/taskPostpone';
import { validateTaskTitle } from '../../domain/taskRules';
import { ScheduleInvariantError, scheduleOf, setTaskSchedule } from '../../domain/taskSchedule';
import type { RecurrenceId, Result, TaskId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { NotImplementedError } from '../../db/repositories';
import type { UndoableCommand } from '../app/undo';
import { createNextOccurrence, UNDONE_OCCURRENCE_INDEX, type CreatedOccurrence } from './recurrenceUseCases';
import type { CreateTaskError, SetRecurrenceError, TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

/**
 * Commande annulable d'une complétion (T-04, T-13, ADR 0005) : annuler = rouvrir
 * la tâche, mais seulement si elle n'a pas changé depuis (hlc identique à celui
 * écrit par `complete`) ; sinon 'stale', sans rien écrire.
 *
 * T-09 : si `complete()` a créé l'occurrence suivante d'une récurrence (`next`), annuler la
 * supprime aussi, dans la même transaction, tant qu'elle n'a pas été modifiée depuis (sinon
 * 'stale', rien n'est écrit). Elle est marquée « annulée » (`UNDONE_OCCURRENCE_INDEX`) avant d'aller à
 * la corbeille : elle n'y est pas listée (pas de doublon à restaurer), son effacement reste synchronisé,
 * et terminer à nouveau la tâche recrée l'occurrence suivante (critère 12).
 */
function createCompleteUndoCommand(deps: TaskUseCaseDeps, completed: Task, wasCarriedOver: boolean, next: CreatedOccurrence | null): UndoableCommand {
  return {
    kind: 'complete',
    count: 1,
    labelParams: { title: completed.title },
    async undo() {
      if (next) {
        const outcome = await deps.data.transaction(async (repos) => {
          const current = await repos.tasks.getById(completed.id);
          if (!current || current.hlc !== completed.hlc) return null;
          const created = await repos.tasks.getById(next.task.id);
          if (created && created.hlc !== next.task.hlc) return null;
          await repos.tasks.reopen(completed.id);
          const reopened = wasCarriedOver ? await repos.tasks.update(completed.id, { carriedOver: true }) : await repos.tasks.getById(completed.id);
          if (created) {
            await repos.tasks.update(created.id, { seriesIndex: UNDONE_OCCURRENCE_INDEX });
            const [removed] = await repos.tasks.softDelete([created.id]);
            await repos.reminders.softDeleteForTarget({ type: 'task', id: created.id }, removed?.deletedAt ?? undefined);
          }
          return { reopened, removedId: created?.id ?? null };
        });
        if (!outcome?.reopened) return 'stale';
        deps.taskEntities.publish([outcome.reopened]);
        if (outcome.removedId) deps.taskEntities.remove([outcome.removedId]);
        return 'undone';
      }
      const current = await deps.data.repos.tasks.getById(completed.id);
      if (!current || current.hlc !== completed.hlc) return 'stale';
      // T-06 : une tâche reportée retrouve son badge (même transaction que la réouverture).
      const reopened = wasCarriedOver
        ? await deps.data.transaction(async (repos) => {
            await repos.tasks.reopen(completed.id);
            return repos.tasks.update(completed.id, { carriedOver: true });
          })
        : await deps.data.repos.tasks.reopen(completed.id);
      deps.taskEntities.publish([reopened]);
      return 'undone';
    },
  };
}

/** État d'une tâche avant et après un report (commande d'annulation, T-05). */
interface PostponedEntry {
  readonly before: Task;
  readonly after: Task;
}

/**
 * Commande annulable d'un report (T-05, T-13) : annuler = nouvelle écriture qui
 * remet date, heure et « Un jour » d'avant. Une tâche modifiée depuis (hlc différent
 * de celui écrit par le report) n'est pas touchée ; si aucune ne peut l'être : 'stale'.
 */
function createPostponeUndoCommand(deps: TaskUseCaseDeps, entries: readonly PostponedEntry[], label: Pick<UndoableCommand, 'labelKey' | 'labelParams'>): UndoableCommand {
  return {
    kind: 'postpone',
    count: entries.length,
    ...label,
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const { before, after } of entries) {
          const current = await repos.tasks.getById(after.id);
          if (!current || current.hlc !== after.hlc) continue;
          written.push(
            await repos.tasks.update(before.id, { date: before.date, time: before.time, someday: before.someday, carriedOver: before.carriedOver, seriesTemplate: before.seriesTemplate }),
          );
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

/**
 * Commande annulable d'une suppression (T-08, T-13) : annuler = nouvelle écriture qui
 * sort la tâche de la corbeille (date, ordre, espace inchangés) et réactive ses rappels.
 * Une tâche modifiée depuis (hlc différent de celui écrit par la suppression, ex. déjà
 * restaurée ou purgée) n'est pas touchée ; si aucune ne peut l'être : 'stale'.
 */
function createDeleteUndoCommand(deps: TaskUseCaseDeps, deleted: readonly Task[]): UndoableCommand {
  const first = deleted[0];
  return {
    kind: 'delete',
    count: deleted.length,
    ...(deleted.length === 1 && first
      ? { labelParams: { title: first.title } }
      : { labelKey: 'undo.deleteMany' as const, labelParams: { count: deleted.length } }),
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const written: Task[] = [];
        for (const task of deleted) {
          const current = await repos.tasks.getById(task.id, { includeDeleted: true });
          if (!current || current.deletedAt === null || current.hlc !== task.hlc) continue;
          const [back] = await repos.tasks.restore([task.id]);
          await repos.reminders.restoreForTarget({ type: 'task', id: task.id }, { deletedAt: current.deletedAt, hlc: current.hlc });
          if (back) written.push(back);
        }
        return written;
      });
      if (restored.length === 0) return 'stale';
      deps.taskEntities.publish(restored);
      return 'undone';
    },
  };
}

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
      // Récurrence et tâche en une transaction (T-09) : la première occurrence a l'indice 0.
      const created = recurrence
        ? await deps.data.transaction(async (repos) => {
            const rule = await repos.recurrences.create({ ...recurrence, id: newEntityId<RecurrenceId>(deps.ids) } satisfies NewRecurrence);
            return repos.tasks.create({ ...newTask, recurrenceId: rule.id, seriesIndex: 0 });
          })
        : await deps.data.repos.tasks.create(newTask);
      deps.taskEntities.publish([created]);
      return { ok: true, value: created };
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
        const written = await deps.data.repos.tasks.update(id, changes);
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
          done.push({ before, after: await repos.tasks.update(id, { ...next.value, carriedOver: false, ...diverge }) });
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
    moveToDay() {
      return Promise.reject(new NotImplementedError('taskUseCases.moveToDay : à implémenter (S-02, S-06)'));
    },
    moveToSomeday() {
      return Promise.reject(new NotImplementedError('taskUseCases.moveToSomeday : à implémenter (SD-03)'));
    },
    duplicate() {
      return Promise.reject(new NotImplementedError('taskUseCases.duplicate : à implémenter (T-12)'));
    },
    async remove(ids): Promise<Task[]> {
      // T-08 : suppression logique (deleted_at) + rappels de la tâche rendus inactifs, en une transaction.
      // Point d'extension T-10 : sur une occurrence récurrente, proposer « cette occurrence /
      // toutes les suivantes » avant d'appeler remove (aucune récurrence n'existe avant T-09).
      const deleted = await deps.data.transaction(async (repos) => {
        const done: Task[] = [];
        for (const id of ids) {
          const before = await repos.tasks.getById(id);
          if (!before) continue; // déjà supprimée ou inconnue : rien à faire
          const [task] = await repos.tasks.softDelete([id]);
          if (!task) continue;
          // Même deleted_at que la tâche : la restauration ne réactive que les rappels supprimés avec elle.
          await repos.reminders.softDeleteForTarget({ type: 'task', id }, task.deletedAt ?? undefined);
          done.push(task);
        }
        return done;
      });
      if (deleted.length === 0) return [];
      // Source unique : la tâche disparaît de toutes les vues (Aujourd'hui, Terminées, fiche…).
      deps.taskEntities.remove(deleted.map((task) => task.id));
      deps.undo.push(createDeleteUndoCommand(deps, deleted));
      return deleted;
    },
    reorder() {
      return Promise.reject(new NotImplementedError('taskUseCases.reorder : à implémenter (A-02, SD-04)'));
    },
  };
}
