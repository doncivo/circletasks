import { calendarOf } from '../../domain/externalEvents';
import { defaultSpaceFor } from '../../domain/spaceRules';
import { taskFromExternalEvent } from '../../domain/taskFromExternalEvent';
import type { Task } from '../../domain/model';
import type { ExternalEventId } from '../../domain/types';
import { t } from '../../i18n';
import { formatDayMonth } from '../../i18n/format';
import { detectTimeZone } from '../../platform';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';
import { createTaskUseCases } from '../tasks/createTaskUseCases';

/**
 * Tâche liée à un événement d'agenda externe (K-04). Une tâche par événement (D3) : un événement déjà lié rend `already-linked` avec
 * sa tâche (« Voir la tâche liée »). La tâche garde le lien après un rafraîchissement (identifiant de ligne déterministe, D4) ; si
 * l'événement disparaît, elle reste intacte. Modifier ou terminer la tâche ne touche jamais l'événement (lecture seule).
 */
export type CreateLinkedTaskResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly error: 'already-linked'; readonly task: Task }
  | { readonly ok: false; readonly error: 'not-found' | 'no-date' | 'no-space' | 'failed' };

type Deps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

/** « Annuler » (message de 5 s, Ctrl+Z) : la tâche créée est écartée, le bouton redevient « Créer une tâche » (critère 8). */
function createLinkedTaskUndoCommand(deps: Deps, task: Task): UndoableCommand {
  return {
    kind: 'linkedTask',
    count: 1,
    labelKey: 'calendars.taskCreated',
    labelParams: { date: task.date === null ? '' : formatDayMonth(task.date) },
    async undo() {
      const removed = await deps.data.transaction(async (repos) => {
        const current = await repos.tasks.getById(task.id);
        if (!current || current.hlc !== task.hlc) return false;
        await repos.tasks.discard([task.id]);
        return true;
      });
      if (!removed) return 'stale';
      deps.taskEntities.remove([task.id]);
      return 'undone';
    },
  };
}

export function createLinkedTaskUseCases(deps: Deps) {
  return {
    /** Tâche vivante liée à l'événement, ou null. */
    linkedTask: (eventId: ExternalEventId): Promise<Task | null> => deps.data.repos.tasks.findByExternalEvent(eventId),

    async createFromEvent(eventId: ExternalEventId): Promise<CreateLinkedTaskResult> {
      try {
        const existing = await deps.data.repos.tasks.findByExternalEvent(eventId);
        if (existing) return { ok: false, error: 'already-linked', task: existing };
        const event = await deps.data.repos.externalEvents.getById(eventId);
        if (!event) return { ok: false, error: 'not-found' };
        const accounts = await deps.data.repos.calendarAccounts.listAll();
        const owner = calendarOf(event, accounts);
        const timeZone = useAppStore.getState().timeZone ?? detectTimeZone() ?? 'UTC';
        const draft = taskFromExternalEvent(event, owner?.calendar ?? null, timeZone, t('calendars.untitled'));
        if (!draft) return { ok: false, error: 'no-date' };
        const spaceId = draft.spaceId ?? defaultSpaceFor('all', useAppStore.getState().spaces);
        if (!spaceId) return { ok: false, error: 'no-space' };
        const created = await createTaskUseCases(deps).create({ title: draft.title, spaceId, date: draft.date, externalEventId: eventId });
        if (!created.ok) return { ok: false, error: 'failed' };
        deps.undo.push(createLinkedTaskUndoCommand(deps, created.value));
        return { ok: true, task: created.value };
      } catch {
        return { ok: false, error: 'failed' };
      }
    },
  };
}

export type LinkedTaskUseCases = ReturnType<typeof createLinkedTaskUseCases>;
