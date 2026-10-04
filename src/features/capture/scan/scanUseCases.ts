import type { DataAccess } from '../../../db/repositories';
import type { ReminderOffsetMin, Task } from '../../../domain/model';
import type { AppContainer } from '../../app/container';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { batchUndoLabel, createCaptureUndoCommand } from '../captureUseCases';
import type { ScanDraft } from './scanDrafts';

type Deps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

export type ScanCreateResult = { readonly ok: true; readonly tasks: readonly Task[] } | { readonly ok: false; readonly error: 'empty' | 'failed' };

/** Refus d'une tâche du lot : annule toute la transaction (aucune tâche à moitié créée). */
class BatchRefused extends Error {}

/**
 * Crée les tâches de la relecture en UNE transaction (Q-04 critère 9) : si l'une échoue, aucune n'est écrite. Chaque tâche a les rappels par
 * défaut quand elle a une heure (comme la saisie d'Aujourd'hui) et l'ordre des lignes est conservé. Un seul message « N tâches créées »
 * avec « Annuler » 5 s, et un seul Ctrl+Z retire tout le lot (même règle que l'annulation d'une copie, T-12). Ne rejette jamais.
 */
export async function createScanTasks(container: Deps, drafts: readonly ScanDraft[]): Promise<ScanCreateResult> {
  if (drafts.length === 0) return { ok: false, error: 'empty' };
  const created: Task[] = [];
  try {
    const defaultOffsets = drafts.some((draft) => draft.time !== null)
      ? await container.data.repos.settings.get('reminders.defaultOffsets').catch((): readonly ReminderOffsetMin[] => [])
      : [];
    const base = container.clock.nowMs();
    await container.data.transaction(async (repos) => {
      // Dans la transaction, les cas d'usage écrivent par ces dépôts-là ; l'horloge avance d'une milliseconde par ligne (ordre conservé).
      const scoped: DataAccess = { repos, transaction: (work) => work(repos) };
      let index = 0;
      const clock = { nowMs: () => base + index };
      const useCases = createTaskUseCases({ ...container, data: scoped, clock });
      for (const draft of drafts) {
        const result = await useCases.create({
          title: draft.title,
          spaceId: draft.spaceId,
          ...(draft.projectId ? { projectId: draft.projectId } : {}),
          date: draft.someday ? null : draft.date,
          ...(draft.someday ? { someday: true } : {}),
          ...(draft.time !== null && !draft.someday ? { time: draft.time } : {}),
          ...(draft.time !== null && !draft.someday && defaultOffsets.length > 0 ? { reminderOffsets: defaultOffsets } : {}),
        });
        if (!result.ok) throw new BatchRefused(result.error);
        created.push(result.value);
        index += 1;
      }
    });
  } catch {
    // Les tâches publiées avant l'échec n'existent pas (transaction annulée) : la source unique les oublie.
    if (created.length > 0) container.taskEntities.remove(created.map((task) => task.id));
    return { ok: false, error: 'failed' };
  }
  container.undo.push(createCaptureUndoCommand(container, created, batchUndoLabel(created)));
  return { ok: true, tasks: created };
}
