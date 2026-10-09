import { taskScheduleOf, type MergeResult } from '../../../domain/appleReminders';
import type { Task } from '../../../domain/model';
import type { IsoDateTime } from '../../../domain/types';
import type { DataAccess } from '../../../db/repositories';
import { syncTaskReminders } from '../../tasks/reminderSync';

type Repos = Parameters<Parameters<DataAccess['transaction']>[0]>[0];

/**
 * Écriture dans la tâche de ce que Rappels a gagné (titre, échéance, statut), par les repositories dans la transaction `repos` (ADR 0008
 * §10.5, « Écritures vers la tâche ») : mêmes invariants que les cas d'usage de tâches (pas d'heure sans date, « Un jour » sans échéance,
 * rappels CircleTasks recalculés, badge « reportée » effacé quand l'échéance vient de Rappels ou que la tâche est terminée). Rend la
 * tâche relue, ou null si rien n'a été écrit. Le passage ne pose pas `sync_guard` : ces écritures sont publiées (visibles sur le PC).
 */
export async function applyValuesToTask(repos: Repos, current: Task, toTask: MergeResult['toTask'], now: IsoDateTime): Promise<Task | null> {
  let written: Task | null = null;
  const patch: Parameters<Repos['tasks']['update']>[1] = {
    ...(toTask.title !== undefined ? { title: toTask.title } : {}),
    ...('date' in toTask || 'time' in toTask ? taskScheduleOf({ date: 'date' in toTask ? (toTask.date ?? null) : current.date, time: 'time' in toTask ? (toTask.time ?? null) : current.time }) : {}),
    ...(toTask.carriedOver === false ? { carriedOver: false } : {}),
  };
  if (Object.keys(patch).length > 0) {
    written = await repos.tasks.update(current.id, patch);
    await syncTaskReminders(repos, written);
  }
  if (toTask.completed === true) {
    written = await repos.tasks.complete(current.id, toTask.doneAt ?? now);
    if (written.carriedOver) written = await repos.tasks.update(current.id, { carriedOver: false });
  } else if (toTask.completed === false) {
    written = await repos.tasks.reopen(current.id);
  }
  return written;
}
