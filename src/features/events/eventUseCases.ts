import { todayLocal } from '../../domain/clock';
import { validateEvent, type EventError } from '../../domain/eventRules';
import { buildEventReminders, normalizeEventReminderOffsets } from '../../domain/eventReminders';
import { newEntityId } from '../../domain/id';
import type { CalendarEvent, EventFields, ReminderOffsetMin } from '../../domain/model';
import type { EventId, ReminderId, Result } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';
import { emitEventsChanged } from './eventEvents';

/**
 * Cas d'usage « événements locaux » (ADR 0004) : les écrans et les stores appellent ces fonctions, jamais les repositories. Règles
 * (titre, plage horaire, occurrences, rappels) : src/domain. Chaque écriture annonce le changement (`emitEventsChanged`).
 */
export type EventUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>;

/** Saisie du formulaire : les champs de l'événement et les avances de rappel cochées (10080, 1440, 0 minute). */
export interface EventInput {
  readonly fields: EventFields;
  readonly reminderOffsets: readonly ReminderOffsetMin[];
}

export type EventSaveError = EventError | 'not-found';

export interface EventUseCases {
  /** E-01 critères 3, 5, 6 : valide, écrit l'événement et ses rappels (`reminder`, target_type `event`) en une transaction. */
  create(input: EventInput): Promise<Result<CalendarEvent, EventError>>;
  /** E-01 critère 7 : une modification s'applique à toute la série ; les rappels sont réécrits. */
  update(id: EventId, input: EventInput): Promise<Result<CalendarEvent, EventSaveError>>;
  /** E-01 critère 7 : suppression annulable 5 s (l'événement et ses rappels reviennent). Renvoie vrai si c'est fait. */
  remove(id: EventId): Promise<boolean>;
  /** Avances des rappels actuels d'un événement (cases du formulaire de modification). */
  reminderOffsets(id: EventId): Promise<ReminderOffsetMin[]>;
}

async function writeReminders(deps: EventUseCaseDeps, repos: Repositories, event: CalendarEvent, offsets: readonly number[]): Promise<void> {
  const rows = buildEventReminders({ event, offsets, today: todayLocal(deps.clock), newReminderId: () => newEntityId<ReminderId>(deps.ids) });
  await repos.reminders.replaceForTarget({ type: 'event', id: event.id as EventId }, rows);
}

/**
 * Annulation d'une suppression (T-13) : restaure l'événement et ses rappels supprimés avec lui, seulement s'il n'a pas changé depuis
 * (même hlc que celui écrit par l'action ; sinon 'stale', rien n'est écrit).
 */
function deletedCommand(deps: EventUseCaseDeps, written: CalendarEvent): UndoableCommand {
  return {
    kind: 'event',
    count: 1,
    labelKey: 'events.undo.deleted',
    labelParams: { title: written.title },
    async undo() {
      const restored = await deps.data.transaction(async (repos) => {
        const current = await repos.events.getById(written.id as EventId, { includeDeleted: true });
        if (!current || current.deletedAt === null || current.hlc !== written.hlc) return false;
        await repos.events.restore(written.id as EventId);
        await repos.reminders.restoreForTarget({ type: 'event', id: written.id as EventId }, { deletedAt: current.deletedAt, hlc: current.hlc });
        return true;
      });
      if (!restored) return 'stale';
      emitEventsChanged(deps.data);
      return 'undone';
    },
  };
}

export function createEventUseCases(deps: EventUseCaseDeps): EventUseCases {
  const { data } = deps;

  return {
    async create(input) {
      const valid = validateEvent(input.fields);
      if (!valid.ok) return valid;
      const event = await data.transaction(async (repos) => {
        const created = await repos.events.create({ id: newEntityId<EventId>(deps.ids), ...valid.value });
        await writeReminders(deps, repos, created, input.reminderOffsets);
        return created;
      });
      emitEventsChanged(data);
      return { ok: true, value: event };
    },

    async update(id, input) {
      const valid = validateEvent(input.fields);
      if (!valid.ok) return valid;
      const event = await data.transaction(async (repos) => {
        if (!(await repos.events.getById(id))) return null;
        const written = await repos.events.update(id, valid.value);
        await writeReminders(deps, repos, written, input.reminderOffsets);
        return written;
      });
      if (!event) return { ok: false, error: 'not-found' };
      emitEventsChanged(data);
      return { ok: true, value: event };
    },

    async remove(id) {
      const deleted = await data.transaction(async (repos) => {
        if (!(await repos.events.getById(id))) return null;
        const removed = await repos.events.softDelete(id);
        // Même deleted_at que l'événement : la restauration ne réactive que les rappels supprimés avec lui.
        await repos.reminders.softDeleteForTarget({ type: 'event', id }, removed.deletedAt ?? undefined);
        return removed;
      });
      if (!deleted) return false;
      deps.undo.push(deletedCommand(deps, deleted));
      emitEventsChanged(data);
      return true;
    },

    async reminderOffsets(id) {
      const reminders = await data.repos.reminders.listForTarget({ type: 'event', id });
      return normalizeEventReminderOffsets(reminders.map((reminder) => reminder.offsetMin));
    },
  };
}
