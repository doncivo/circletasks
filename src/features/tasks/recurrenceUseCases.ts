import { todayLocal } from '../../domain/clock';
import { newEntityId } from '../../domain/id';
import type { RecurrenceFields, Reminder, Task } from '../../domain/model';
import { buildNextOccurrence, decideNextOccurrence } from '../../domain/recurrenceNext';
import type { LocalDate, ReminderId, TaskId } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import type { TaskUseCaseDeps } from './taskUseCases';

export type RecurrenceDeps = Pick<TaskUseCaseDeps, 'clock' | 'ids' | 'data' | 'taskEntities'>;

/**
 * `seriesIndex` posé sur l'occurrence créée puis retirée par l'annulation d'une complétion : jamais compté
 * comme occurrence existante de la série, exclu de la corbeille (`TaskRepository.listTrash`).
 */
export const UNDONE_OCCURRENCE_INDEX = -1;

/** Occurrence créée avec ses rappels recopiés (T-09 critère 7). */
export interface CreatedOccurrence {
  readonly task: Task;
  readonly reminders: readonly Reminder[];
}

/** Champs de la règle (sans colonnes de synchro) : seul ce sous-ensemble est lu par le domaine. */
function fieldsOf(rule: RecurrenceFields): RecurrenceFields {
  const { freq, interval, weekdays, monthDay, nthWeekday, until, count } = rule;
  return { freq, interval, weekdays, monthDay, nthWeekday, until, count };
}

/**
 * Crée, dans la transaction `repos`, l'occurrence suivante de `source` (terminée ou passée), ou
 * rend null (pas de récurrence, série terminée, suivante déjà créée : corbeille comprise, T-09
 * critère 12). La date suit la règle depuis la date PRÉVUE de `source` (critères 9, 11). Si cette
 * date est déjà passée (app fermée plusieurs occurrences), les occurrences manquées intermédiaires
 * ne sont pas stockées (une tâche récurrente ne stocke que l'occurrence en cours, PRD 6) : on crée
 * la première occurrence à partir d'aujourd'hui, `seriesIndex` comptant les occurrences sautées
 * (une fin « après N fois » reste exacte).
 */
export async function createNextOccurrence(
  deps: RecurrenceDeps,
  repos: Repositories,
  source: Task,
  today: LocalDate,
): Promise<CreatedOccurrence | null> {
  if (source.recurrenceId === null) return null;
  const stored = await repos.recurrences.getById(source.recurrenceId);
  if (!stored) return null; // règle arrêtée ou supprimée (T-10)
  const rule = fieldsOf(stored);
  const siblings = await repos.tasks.listByRecurrence(source.recurrenceId, { includeDeleted: true });
  const existingSeriesIndexes = siblings.flatMap((t) => (t.seriesIndex === null ? [] : [t.seriesIndex]));

  const first = decideNextOccurrence({ task: source, rule, today, existingSeriesIndexes });
  if (!first.create) return null;
  let { date, seriesIndex } = first;
  while (date < today) {
    const again = decideNextOccurrence({
      task: { date, status: 'todo', recurrenceId: source.recurrenceId, seriesIndex },
      rule,
      today,
    });
    if (!again.create) return null; // la série se termine avant aujourd'hui
    ({ date, seriesIndex } = again);
  }

  const offsets = (await repos.reminders.listForTarget({ type: 'task', id: source.id })).map((r) => r.offsetMin);
  const built = buildNextOccurrence(source, {
    taskId: newEntityId<TaskId>(deps.ids),
    date,
    seriesIndex,
    reminderOffsets: offsets,
    newReminderId: () => newEntityId<ReminderId>(deps.ids),
  });
  const task = await repos.tasks.create(built.task);
  const reminders =
    built.reminders.length === 0 ? [] : await repos.reminders.replaceForTarget({ type: 'task', id: task.id }, built.reminders);
  return { task, reminders };
}

export interface RecurrenceUseCases {
  /**
   * T-09 critère 10 : crée l'occurrence suivante des occurrences récurrentes à faire dont le jour
   * est passé (une transaction). À appeler AVANT le report automatique de T-06 (qui change la date
   * des occurrences passées, Q2). Idempotent (pas de doublon, critère 12). Rend les occurrences créées.
   */
  generateDue(): Promise<Task[]>;
}

export function createRecurrenceUseCases(deps: RecurrenceDeps): RecurrenceUseCases {
  return {
    async generateDue() {
      const today = todayLocal(deps.clock);
      const created = await deps.data.transaction(async (repos) => {
        const undone = await repos.tasks.listUndoneBefore(today);
        const out: Task[] = [];
        for (const task of undone) {
          if (task.recurrenceId === null) continue;
          const next = await createNextOccurrence(deps, repos, task, today);
          if (next) out.push(next.task);
        }
        return out;
      });
      deps.taskEntities.publish(created);
      return created;
    },
  };
}
