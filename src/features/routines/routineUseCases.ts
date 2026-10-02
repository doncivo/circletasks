import { newEntityId } from '../../domain/id';
import { nowIso, todayLocal } from '../../domain/clock';
import { addDays } from '../../domain/localDate';
import type { NewReminder, ReminderOffsetMin, Routine, RoutineFields } from '../../domain/model';
import { mergeReminderOffsets, normalizeReminderOffsets, routineReminderFireAt } from '../../domain/routineReminder';
import { validateRoutine, type RoutineError } from '../../domain/routineRules';
import { canToggleDay, doneDatesOf, mondayOf } from '../../domain/routineSchedule';
import type { LocalDate, ReminderId, Result, RoutineId, RoutineLogId } from '../../domain/types';
import type { DataAccess } from '../../db/repositories';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';
import { emitRoutinesChanged } from './routineEvents';

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
  /**
   * R-03 : valide (`done` vrai) ou rouvre le jour `date` d'une routine ; annulable 5 s (T-13). Une validation par routine et par jour
   * (`routine_log` unique) : valider un jour déjà validé n'écrit rien (double clic, synchro). Refusés sans rien écrire : jour futur,
   * jour non prévu, routine en pause ou archivée, « X fois par semaine » dont le quota est atteint (QB-01, QB-03). Renvoie ce qui a
   * été fait.
   */
  setDone(id: RoutineId, date: LocalDate, done: boolean): Promise<'validated' | 'reopened' | 'ignored'>;
}

type Repos = DataAccess['repos'];

/**
 * Annulation d'une validation (T-13) : retire la validation, seulement si elle n'a pas changé depuis (même hlc que celui écrit par
 * l'action : sinon une synchro ou une autre action l'a touchée, 'stale', rien n'est écrit).
 */
function validatedCommand(deps: RoutineUseCaseDeps, routine: Routine, date: LocalDate, hlc: string): UndoableCommand {
  return {
    kind: 'routine',
    count: 1,
    labelKey: 'routines.undo.validated',
    labelParams: { title: routine.title },
    async undo() {
      const [current] = await deps.data.repos.routineLogs.listForRoutine(routine.id as RoutineId, { from: date, to: date });
      if (!current || current.hlc !== hlc) return 'stale';
      await deps.data.repos.routineLogs.unmark(routine.id as RoutineId, date);
      emitRoutinesChanged(deps.data);
      return 'undone';
    },
  };
}

/** Annulation d'une réouverture : revalide le jour, sauf s'il l'a été entre-temps (autre action, synchro). */
function reopenedCommand(deps: RoutineUseCaseDeps, routine: Routine, date: LocalDate): UndoableCommand {
  return {
    kind: 'routine',
    count: 1,
    labelKey: 'routines.undo.reopened',
    labelParams: { title: routine.title },
    async undo() {
      const [current] = await deps.data.repos.routineLogs.listForRoutine(routine.id as RoutineId, { from: date, to: date });
      if (current) return 'stale';
      await deps.data.repos.routineLogs.markDone(routine.id as RoutineId, date, nowIso(deps.clock), newEntityId<RoutineLogId>(deps.ids));
      emitRoutinesChanged(deps.data);
      return 'undone';
    },
  };
}

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
      emitRoutinesChanged(deps.data);
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
      emitRoutinesChanged(deps.data);
      return { ok: true, value: updated };
    },

    async setDone(id, date, done) {
      // Lecture, contrôle et écriture en une transaction : deux validations simultanées du même jour (double clic, synchro locale)
      // se suivent, la seconde voit la première et n'écrit rien (routine_log unique par routine et par jour, critère 3).
      const outcome = await deps.data.transaction(
        async (repos): Promise<{ readonly result: 'validated' | 'reopened' | 'ignored'; readonly command?: UndoableCommand }> => {
          const routine = await repos.routines.getById(id);
          if (!routine) return { result: 'ignored' };
          const weekStart = mondayOf(date);
          const week = doneDatesOf(await repos.routineLogs.listForRoutine(id, { from: weekStart, to: addDays(weekStart, 6) }), id);
          const today = todayLocal(deps.clock);
          if (done) {
            if (week.has(date) || !canToggleDay(routine, week, date, today)) return { result: 'ignored' };
            const log = await repos.routineLogs.markDone(id, date, nowIso(deps.clock), newEntityId<RoutineLogId>(deps.ids));
            return { result: 'validated', command: validatedCommand(deps, routine, date, log.hlc) };
          }
          if (!week.has(date) || !canToggleDay(routine, week, date, today)) return { result: 'ignored' };
          await repos.routineLogs.unmark(id, date);
          return { result: 'reopened', command: reopenedCommand(deps, routine, date) };
        },
      );
      if (outcome.command) deps.undo.push(outcome.command);
      if (outcome.result !== 'ignored') emitRoutinesChanged(deps.data);
      return outcome.result;
    },

    async reminderOffsets(id) {
      const reminders = await deps.data.repos.reminders.listForTarget({ type: 'routine', id });
      return reminders.map((reminder) => reminder.offsetMin);
    },
  };
}
