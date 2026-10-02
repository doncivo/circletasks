import { nowIso, todayLocal } from '../../domain/clock';
import { newEntityId } from '../../domain/id';
import type { NewTask, Task, TaskPatch } from '../../domain/model';
import { completeTask, isCompleted } from '../../domain/taskCompletion';
import { nextDayFrom, postponeTask, resolvePostponeDate } from '../../domain/taskPostpone';
import { validateTaskTitle } from '../../domain/taskRules';
import { ScheduleInvariantError, scheduleOf, setTaskSchedule } from '../../domain/taskSchedule';
import type { Result, TaskId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { NotImplementedError } from '../../db/repositories';
import type { UndoableCommand } from '../app/undo';
import type { CreateTaskError, TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

/**
 * Commande annulable d'une complétion (T-04, T-13, ADR 0005) : annuler = rouvrir
 * la tâche, mais seulement si elle n'a pas changé depuis (hlc identique à celui
 * écrit par `complete`) ; sinon 'stale', sans rien écrire.
 *
 * Point d'extension (T-09) : si `complete()` a créé l'occurrence suivante d'une
 * récurrence, cette commande devra aussi la supprimer ici (critère 7) — rien
 * n'est fait tant que T-09 n'existe pas.
 */
function createCompleteUndoCommand(deps: TaskUseCaseDeps, completed: Task): UndoableCommand {
  return {
    kind: 'complete',
    count: 1,
    labelParams: { title: completed.title },
    async undo() {
      const current = await deps.data.repos.tasks.getById(completed.id);
      if (!current || current.hlc !== completed.hlc) return 'stale';
      deps.taskEntities.publish([await deps.data.repos.tasks.reopen(completed.id)]);
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
          written.push(await repos.tasks.update(before.id, { date: before.date, time: before.time, someday: before.someday }));
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
        goalId: input.goalId ?? null,
        icon: input.icon ?? null,
        someday,
        source: 'local',
        externalId: null,
      };
      const created = await deps.data.repos.tasks.create(newTask);
      deps.taskEntities.publish([created]);
      return { ok: true, value: created };
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

      return write({ ...patch, ...scheduled.value });
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
      const updated = await deps.data.repos.tasks.complete(id, doneAt);
      deps.taskEntities.publish([updated]);

      // Point d'extension T-09 (récurrence) : si `updated.recurrenceId` n'est pas
      // null, générer ici l'occurrence suivante (src/domain/recurrence.ts, à
      // écrire par T-09) et l'annuler avec la même commande. Non implémenté :
      // seule l'occurrence courante est terminée.

      deps.undo.push(createCompleteUndoCommand(deps, updated));
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
          // `carriedOver` n'est jamais posé ici (critère 7, réservé à T-06).
          done.push({ before, after: await repos.tasks.update(id, next.value) });
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
    remove() {
      return Promise.reject(new NotImplementedError('taskUseCases.remove : à implémenter (T-08)'));
    },
    reorder() {
      return Promise.reject(new NotImplementedError('taskUseCases.reorder : à implémenter (A-02, SD-04)'));
    },
  };
}
