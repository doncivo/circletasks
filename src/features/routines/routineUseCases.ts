import { newEntityId } from '../../domain/id';
import { todayLocal } from '../../domain/clock';
import type { NewReminder, ReminderOffsetMin, Routine, RoutineFields } from '../../domain/model';
import { mergeReminderOffsets, normalizeReminderOffsets, routineReminderFireAt } from '../../domain/routineReminder';
import { validateRoutine, type RoutineError } from '../../domain/routineRules';
import type { ReminderId, Result, RoutineId } from '../../domain/types';
import type { DataAccess } from '../../db/repositories';
import type { AppContainer } from '../app/container';

/**
 * Cas d'usage « routines » (ADR 0004) : les stores appellent ces fonctions, jamais les repositories directement. Les règles
 * (titre, fréquence, bornes de N, rappels) sont dans src/domain ; aucune occurrence n'est écrite d'avance : seules les validations
 * iront dans `routine_log` (R-03).
 */
export type RoutineUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>;

/** Ce que saisit le formulaire : la routine et les avances de rappel cochées (« À l'heure », « 30 min »). */
export interface RoutineInput {
  readonly fields: RoutineFields;
  readonly reminderOffsets: readonly ReminderOffsetMin[];
}

export interface RoutineUseCases {
  /** R-01, R-02, R-07 : crée une routine et ses rappels en une transaction. */
  create(input: RoutineInput): Promise<Result<Routine, RoutineError>>;
  /**
   * R-01, R-02, R-07 : enregistre le formulaire d'une routine existante ; les validations passées sont conservées. Les rappels
   * gardent leur avance, leur échéance est recalculée (changement d'heure) ; sans heure, aucun rappel (QB-07).
   */
  update(id: RoutineId, input: RoutineInput): Promise<Result<Routine, RoutineError>>;
  /** R-02 : avances des rappels actuels d'une routine. */
  reminderOffsets(id: RoutineId): Promise<ReminderOffsetMin[]>;
}

type Repos = DataAccess['repos'];

export function createRoutineUseCases(deps: RoutineUseCaseDeps): RoutineUseCases {
  /** Remplace les rappels d'une routine : échéance de la prochaine occurrence (aujourd'hui compris) pour chaque avance. */
  async function writeReminders(repos: Repos, routine: Routine, offsets: readonly ReminderOffsetMin[]): Promise<void> {
    const time = routine.time;
    const wanted = normalizeReminderOffsets(offsets, time);
    const from = todayLocal(deps.clock);
    const reminders: NewReminder[] = [];
    for (const offsetMin of wanted) {
      const fireAt = time === null ? null : routineReminderFireAt(routine, time, from, offsetMin);
      if (fireAt === null) continue;
      reminders.push({ id: newEntityId<ReminderId>(deps.ids), targetType: 'routine', targetId: routine.id, offsetMin, fireAt });
    }
    await repos.reminders.replaceForTarget({ type: 'routine', id: routine.id as RoutineId }, reminders);
  }

  return {
    async create(input) {
      const checked = validateRoutine(input.fields);
      if (!checked.ok) return checked;
      const created = await deps.data.transaction(async (repos) => {
        const routine = await repos.routines.create({ ...checked.value, id: newEntityId<RoutineId>(deps.ids) });
        if (routine.time !== null && input.reminderOffsets.length > 0) await writeReminders(repos, routine, input.reminderOffsets);
        return routine;
      });
      return { ok: true, value: created };
    },

    async update(id, input) {
      const checked = validateRoutine(input.fields);
      if (!checked.ok) return checked;
      const updated = await deps.data.transaction(async (repos) => {
        const routine = await repos.routines.update(id, checked.value);
        const existing = (await repos.reminders.listForTarget({ type: 'routine', id })).map((reminder) => reminder.offsetMin);
        // Les avances que le formulaire ne montre pas (N-02) restent ; sans heure, plus aucun rappel.
        const offsets = mergeReminderOffsets(existing, input.reminderOffsets);
        if (existing.length > 0 || (routine.time !== null && offsets.length > 0)) await writeReminders(repos, routine, offsets);
        return routine;
      });
      return { ok: true, value: updated };
    },

    async reminderOffsets(id) {
      const reminders = await deps.data.repos.reminders.listForTarget({ type: 'routine', id });
      return reminders.map((reminder) => reminder.offsetMin);
    },
  };
}
