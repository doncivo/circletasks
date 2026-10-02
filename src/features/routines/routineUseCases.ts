import { newEntityId } from '../../domain/id';
import { nowIso, todayLocal } from '../../domain/clock';
import { addDays } from '../../domain/localDate';
import type { NewReminder, ReminderOffsetMin, Routine, RoutineFields } from '../../domain/model';
import { mergeReminderOffsets, normalizeReminderOffsets, routineReminderFireAt } from '../../domain/routineReminder';
import { validateRoutine, type RoutineError } from '../../domain/routineRules';
import { canToggleDay, doneDatesOf, mondayOf, pausesByRoutine } from '../../domain/routineSchedule';
import type { LocalDate, ReminderId, Result, RoutineId, RoutineLogId, RoutinePauseId } from '../../domain/types';
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
  /**
   * R-05 : met en pause (`true`) ou reprend (`false`) une routine ; annulable. Aucune occurrence tant que la pause dure, historique
   * intact. Renvoie la routine écrite, null si elle n'existe plus ou est déjà dans l'état voulu.
   */
  setPaused(id: RoutineId, paused: boolean): Promise<Routine | null>;
  /**
   * R-05 : archive (`true`) ou restaure (`false`) une routine ; annulable 5 s. Ses validations (`routine_log`) restent en base et
   * dans les statistiques. Renvoie la routine écrite, null si elle n'existe plus ou est déjà dans l'état voulu.
   */
  setArchived(id: RoutineId, archived: boolean): Promise<Routine | null>;
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

/** Ce qu'a fait un changement de pause sur l'historique des périodes (pour l'annuler). */
type PauseRecord = { readonly kind: 'opened'; readonly id: RoutinePauseId } | { readonly kind: 'closed'; readonly id: RoutinePauseId; readonly deleted: boolean } | null;


/**
 * Historique des pauses (R-04 critère 5) : mettre en pause ouvre une période à `today` ; reprendre la ferme à la veille, ou la supprime
 * logiquement si elle n'a couvert aucun jour (pause et reprise le même jour).
 */
async function syncPausePeriod(deps: RoutineUseCaseDeps, repos: Repos, routineId: RoutineId, paused: boolean): Promise<PauseRecord> {
  const today = todayLocal(deps.clock);
  const periods = await repos.routines.listPausesForRoutine(routineId);
  const open = periods.find((period) => period.toDate === null);
  if (paused) {
    if (open) return null;
    const created = await repos.routines.createPause({ id: newEntityId<RoutinePauseId>(deps.ids), routineId, fromDate: today });
    return { kind: 'opened', id: created.id as RoutinePauseId };
  }
  if (!open) return null;
  const yesterday = addDays(today, -1);
  if (yesterday < open.fromDate) {
    await repos.routines.deletePause(open.id as RoutinePauseId);
    return { kind: 'closed', id: open.id as RoutinePauseId, deleted: true };
  }
  await repos.routines.setPauseEnd(open.id as RoutinePauseId, yesterday);
  return { kind: 'closed', id: open.id as RoutinePauseId, deleted: false };
}

/** Annule l'effet de `syncPausePeriod` sur les périodes. */
async function undoPausePeriod(repos: Repos, record: PauseRecord): Promise<void> {
  if (!record) return;
  if (record.kind === 'opened') await repos.routines.deletePause(record.id);
  else if (record.deleted) await repos.routines.restorePause(record.id);
  else await repos.routines.setPauseEnd(record.id, null);
}

/**
 * Annulation d'un changement d'état d'une routine (pause, archivage) : remet l'état d'avant, seulement si la routine n'a pas changé
 * depuis (même hlc que celui écrit par l'action ; sinon 'stale', rien n'est écrit).
 */
function stateCommand(
  deps: RoutineUseCaseDeps,
  written: Routine,
  patch: { readonly paused: boolean } | { readonly archived: boolean },
  record: PauseRecord,
  labelKey: 'routines.undo.paused' | 'routines.undo.resumed' | 'routines.undo.archived' | 'routines.undo.restored',
): UndoableCommand {
  return {
    kind: 'routine',
    count: 1,
    labelKey,
    labelParams: { title: written.title },
    async undo() {
      const current = await deps.data.repos.routines.getById(written.id as RoutineId);
      if (!current || current.hlc !== written.hlc) return 'stale';
      await deps.data.transaction(async (repos) => {
        await repos.routines.update(written.id as RoutineId, patch);
        await undoPausePeriod(repos, record);
      });
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
        const before = await repos.routines.getById(id);
        const routine = await repos.routines.update(id, checked.value);
        if (before && before.paused !== routine.paused) await syncPausePeriod(deps, repos, id, routine.paused);
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
          const pauses = pausesByRoutine(await repos.routines.listPausesForRoutine(id)).get(id) ?? [];
          if (done) {
            if (week.has(date) || !canToggleDay(routine, week, date, today, pauses)) return { result: 'ignored' };
            const log = await repos.routineLogs.markDone(id, date, nowIso(deps.clock), newEntityId<RoutineLogId>(deps.ids));
            return { result: 'validated', command: validatedCommand(deps, routine, date, log.hlc) };
          }
          if (!week.has(date) || !canToggleDay(routine, week, date, today, pauses)) return { result: 'ignored' };
          await repos.routineLogs.unmark(id, date);
          return { result: 'reopened', command: reopenedCommand(deps, routine, date) };
        },
      );
      if (outcome.command) deps.undo.push(outcome.command);
      if (outcome.result !== 'ignored') emitRoutinesChanged(deps.data);
      return outcome.result;
    },

    async setPaused(id, paused) {
      const before = await deps.data.repos.routines.getById(id);
      if (!before || before.paused === paused) return null;
      const { written, record } = await deps.data.transaction(async (repos) => ({
        written: await repos.routines.setPaused(id, paused),
        record: await syncPausePeriod(deps, repos, id, paused),
      }));
      deps.undo.push(stateCommand(deps, written, { paused: before.paused }, record, paused ? 'routines.undo.paused' : 'routines.undo.resumed'));
      emitRoutinesChanged(deps.data);
      return written;
    },

    async setArchived(id, archived) {
      const before = await deps.data.repos.routines.getById(id);
      if (!before || before.archived === archived) return null;
      const written = await deps.data.repos.routines.setArchived(id, archived);
      deps.undo.push(stateCommand(deps, written, { archived: before.archived }, null, archived ? 'routines.undo.archived' : 'routines.undo.restored'));
      emitRoutinesChanged(deps.data);
      return written;
    },

    async reminderOffsets(id) {
      const reminders = await deps.data.repos.reminders.listForTarget({ type: 'routine', id });
      return reminders.map((reminder) => reminder.offsetMin);
    },
  };
}
