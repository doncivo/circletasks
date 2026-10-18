import type { Task } from '../../domain/model';
import { occurrenceReminderId, occurrenceTaskId } from '../../domain/occurrenceId';
import { seriesSourceOf } from '../../domain/recurrenceEdit';
import { buildNextOccurrence } from '../../domain/recurrenceNext';
import { uuidGenerator } from '../../domain/id';
import type { LocalDate, ReminderId, TaskId } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import { UNDONE_OCCURRENCE_INDEX, type CreatedOccurrence } from './recurrenceUseCases';

/**
 * T-TECH-01 (B8) : écriture de l'occurrence `seriesIndex` de la série de `source`, sous un identifiant déterministe (UUID v5 de
 * `(recurrence_id, series_index)`) et avec des rappels à identifiant déterministe (UUID v5 de `(task_id, offset_min)`). Deux appareils qui
 * génèrent la même occurrence avant de s'être lus écrivent donc la MÊME ligne, que la fusion réunit au lieu de la dédoubler.
 *
 * - ligne absente : insérée ;
 * - ligne présente et vivante, ou en corbeille avec son index (supprimée à la main, T-09 critère 12) : rien (null) ;
 * - ligne annulée par T-09 (supprimée, `series_index` = `UNDONE_OCCURRENCE_INDEX`) : ressuscitée, mêmes identifiants, jamais une erreur
 *   de clé primaire (les rappels supprimés avec elle sont rétablis par `replaceForTarget`).
 *
 * Module chargé à la demande par `createNextOccurrence` (bundle de départ, PRD 8).
 */
export async function placeOccurrence(repos: Repositories, source: Task, date: LocalDate, seriesIndex: number): Promise<CreatedOccurrence | null> {
  // I2 : un identifiant déterministe retombé sur une ligne purgée (trace de suppression) serait rejeté par l'autre appareil (`purged`) : identifiant
  // aléatoire pour la tâche, et pour chaque rappel dans le même cas.
  const purged = async (table: string, id: string): Promise<boolean> => (await repos.sync.tombstones(table, [id])).has(id);
  let taskId = await occurrenceTaskId(source.recurrenceId as NonNullable<Task['recurrenceId']>, seriesIndex);
  if (await purged('task', taskId)) taskId = uuidGenerator.next() as TaskId;
  const known = await repos.tasks.getById(taskId, { includeDeleted: true });
  if (known && known.seriesIndex !== UNDONE_OCCURRENCE_INDEX) return null;
  const offsets = (await repos.reminders.listForTarget({ type: 'task', id: source.id })).map((r) => r.offsetMin);
  // `buildNextOccurrence` demande un identifiant par rappel, dans l'ordre des avances : calculés d'avance (le calcul est asynchrone).
  const reminderIds = await Promise.all(offsets.map(async (offset) => {
    const id = await occurrenceReminderId(taskId, offset);
    return (await purged('reminder', id)) ? (uuidGenerator.next() as ReminderId) : id;
  }));
  let next = 0;
  const built = buildNextOccurrence(seriesSourceOf(source), { taskId, date, seriesIndex, reminderOffsets: offsets, newReminderId: () => reminderIds[next++] as ReminderId });
  if (known) await repos.tasks.restore([taskId]);
  const task = known ? await repos.tasks.update(taskId, built.task) : await repos.tasks.create(built.task);
  const reminders = built.reminders.length === 0 ? [] : await repos.reminders.replaceForTarget({ type: 'task', id: task.id }, built.reminders);
  return { task, reminders };
}
