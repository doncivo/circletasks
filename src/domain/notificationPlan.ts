import { compareCodeUnits } from './compareCodeUnits';
import { occurrenceStarts } from './eventOccurrences';
import { eventReminderTime } from './eventReminders';
import { addDays } from './localDate';
import {
  isEventReminderOffset,
  isReminderOffset,
  type CalendarEvent,
  type Reminder,
  type ReminderOffsetMin,
  type ReminderTargetType,
  type Routine,
  type RoutineLog,
  type RoutinePause,
  type Space,
  type Task,
} from './model';
import { eventNotificationId, recapNotificationId, routineNotificationId, taskNotificationId } from './notificationId';
import { effectiveFireAt } from './quietHours';
import { buildRecap, type Recap, type RecapKind, type RecapSettings } from './recap';
import { reminderFireAt } from './recurrenceNext';
import { groupDoneDates, isActive, isPlannedOn, isQuotaRule, pausesByRoutine, quotaReached, type DateInterval } from './routineSchedule';
import {
  isLocalDate,
  isLocalDateTime,
  isLocalTime,
  type EventId,
  type LocalDate,
  type LocalDateTime,
  type ReminderId,
  type RoutineId,
  type SpaceId,
  type TaskId,
} from './types';

/**
 * Planificateur de notifications (N-TECH-01, ADR 0012 section 5) : fonction pure qui rend les prochaines notifications à poser sur
 * l'iPhone, déjà triées, plafonnées et sans texte. Le texte, la lecture en base, la conversion en instant et l'envoi sont de N-01.
 *
 * - Aucune horloge : `now` est fourni (heure locale flottante). Aucun fuseau : tout est en dates civiles (critère 23).
 * - Échéance toujours recalculée depuis la cible ; `reminder.fire_at` et `reminder.delivered` ne sont jamais lus.
 * - Ne lève jamais : une donnée incohérente ne produit aucun élément.
 */

export const NOTIFICATION_HORIZON_DAYS = 400;
/** Plafond iOS des notifications locales en attente. */
export const NOTIFICATION_LIMIT_DEFAULT = 64;

export interface NotificationPlanInput {
  readonly now: LocalDateTime;
  /** Entier 0 à 64 ; N-01 passe 64 moins les notifications réservées en attente (fin de Focus). */
  readonly limit?: number;
  /** Au moins : les cibles des rappels vivants et les tâches datées du jour de `now` (contenu du récapitulatif). */
  readonly tasks: readonly Task[];
  readonly routines: readonly Routine[];
  readonly routinePauses: readonly RoutinePause[];
  readonly routineLogs: readonly RoutineLog[];
  readonly events: readonly CalendarEvent[];
  readonly reminders: readonly Reminder[];
  readonly spaces: readonly Pick<Space, 'id' | 'quietHours'>[];
  readonly recaps: RecapSettings;
}

interface PlannedReminderBase {
  readonly id: string;
  readonly reminderId: ReminderId;
  readonly offsetMin: ReminderOffsetMin;
  readonly spaceId: SpaceId;
  /** Jour de l'occurrence (tâche : sa date ; routine, événement : l'occurrence visée). */
  readonly occurrenceDate: LocalDate;
  /** Échéance d'origine, avant les plages silencieuses (information). */
  readonly scheduledAt: LocalDateTime;
  /** Échéance effective, après les plages silencieuses : celle du tri, du plafond et de l'envoi. */
  readonly fireAt: LocalDateTime;
}

export type PlannedItem =
  | (PlannedReminderBase & { readonly kind: 'task'; readonly targetId: TaskId })
  | (PlannedReminderBase & { readonly kind: 'routine'; readonly targetId: RoutineId })
  | (PlannedReminderBase & { readonly kind: 'event'; readonly targetId: EventId })
  | {
      readonly kind: 'recap';
      readonly id: string;
      readonly recapKind: RecapKind;
      readonly day: LocalDate;
      readonly fireAt: LocalDateTime;
      /** Calculé pour le jour de `now` seulement ; `null` ensuite (N-01 affiche le texte générique, N-07). */
      readonly content: Recap | null;
    };

export type PlanCoverage =
  | { readonly state: 'complete' }
  | { readonly state: 'until'; readonly until: LocalDateTime }
  | { readonly state: 'empty' };

export interface NotificationPlan {
  readonly items: readonly PlannedItem[];
  readonly coverage: PlanCoverage;
  /** Nombre de candidats avant le plafond. */
  readonly total: number;
}

const EMPTY_PLAN: NotificationPlan = { items: [], coverage: { state: 'empty' }, total: 0 };


/** Tri du plan : échéance effective, puis rappel avant récapitulatif, puis identifiant (unités de code, jamais localeCompare). */
function comparePlanned(a: PlannedItem, b: PlannedItem): number {
  if (a.fireAt !== b.fireAt) return compareCodeUnits(a.fireAt, b.fireAt);
  const rank = (item: PlannedItem): number => (item.kind === 'recap' ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return compareCodeUnits(a.id, b.id);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return NOTIFICATION_LIMIT_DEFAULT;
  return Math.min(NOTIFICATION_LIMIT_DEFAULT, Math.max(0, Math.floor(limit)));
}

/** Avances admises selon la cible, comme le modèle (migration 0009) : événement = 10080, 1440, 0 ; tâche et routine = liste de N-02. */
const isOffset = (targetType: ReminderTargetType, value: number): value is ReminderOffsetMin =>
  targetType === 'event' ? isEventReminderOffset(value) : isReminderOffset(value);

/** Échéance (heure locale flottante) ou null si la date ou l'heure sont mal formées. */
function fireAtOf(date: LocalDate, time: string | null, offsetMin: number): LocalDateTime | null {
  if (time === null || !isLocalDate(date) || !isLocalTime(time)) return null;
  const fireAt = reminderFireAt(date, time, offsetMin);
  return isLocalDateTime(fireAt) ? fireAt : null;
}

/** Lignes vivantes, une par (nature, cible, avance) : la ligne d'identifiant le plus petit (critère 9). */
function dedupReminders(reminders: readonly Reminder[]): Reminder[] {
  const kept = new Map<string, Reminder>();
  for (const reminder of reminders) {
    if (reminder.deletedAt !== null || !isOffset(reminder.targetType, reminder.offsetMin)) continue;
    const key = `${reminder.targetType}|${reminder.targetId}|${reminder.offsetMin}`;
    const known = kept.get(key);
    if (known === undefined || compareCodeUnits(reminder.id, known.id) < 0) kept.set(key, reminder);
  }
  return [...kept.values()];
}

function indexById<T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** Plan des prochaines notifications (critères 7 à 24). */
export function planNotifications(input: NotificationPlanInput): NotificationPlan {
  const nowMinute = String(input.now).slice(0, 16);
  if (!isLocalDateTime(nowMinute)) return EMPTY_PLAN;
  const today = nowMinute.slice(0, 10) as LocalDate;
  const horizonEnd = addDays(today, NOTIFICATION_HORIZON_DAYS);
  const limit = clampLimit(input.limit);
  const horizonLimit = `${horizonEnd}T23:59`;

  const quietBySpace = new Map(input.spaces.map((space) => [space.id as string, space.quietHours]));
  const candidates: PlannedItem[] = [];

  /** Applique les plages de l'espace et écarte l'échéance effective passée (critère 8) ; rend l'échéance effective ou null. */
  const effectiveOf = (spaceId: SpaceId, scheduledAt: LocalDateTime, bounded = false): LocalDateTime | null => {
    const fireAt = effectiveFireAt(scheduledAt, quietBySpace.get(spaceId) ?? []);
    const minute = fireAt.slice(0, 16);
    return minute > nowMinute && (!bounded || minute <= horizonLimit) ? fireAt : null;
  };

  const reminders = dedupReminders(input.reminders);
  // L'horizon borne l'ÉCHÉANCE (routines, événements) : les occurrences sont cherchées jusqu'à la plus grande avance au-delà, puis
  // filtrées sur l'échéance effective. Ainsi `complete` est exact. Les tâches n'ont pas d'horizon.
  const maxLeadDays = Math.ceil(reminders.reduce((max, reminder) => Math.max(max, reminder.offsetMin), 0) / 1440);
  const searchEnd = addDays(horizonEnd, maxLeadDays);
  const tasks = indexById(input.tasks);
  const routines = indexById(input.routines);
  const events = indexById(input.events);
  const doneByRoutine = groupDoneDates(input.routineLogs);
  const pauses = pausesByRoutine(input.routinePauses);
  const routineDates = new Map<string, readonly LocalDate[]>();
  const eventDates = new Map<string, readonly LocalDate[]>();

  /** Jours où la routine a une occurrence rappelable (critère 13), dans l'horizon. Calculés une fois par routine. */
  const routineEligibleDates = (routine: Routine): readonly LocalDate[] => {
    const known = routineDates.get(routine.id);
    if (known !== undefined) return known;
    const rulePauses: readonly DateInterval[] = pauses.get(routine.id) ?? [];
    const done = doneByRoutine.get(routine.id) ?? new Set<LocalDate>();
    const dates: LocalDate[] = [];
    if (routine.deletedAt === null && !routine.archived && isLocalDate(routine.startDate)) {
      for (let day = today; day <= searchEnd; day = addDays(day, 1)) {
        if (!isActive(routine, day, rulePauses) || !isPlannedOn(routine, day, rulePauses) || done.has(day)) continue;
        if (isQuotaRule(routine) && quotaReached(routine, done, day, rulePauses)) continue;
        dates.push(day);
      }
    }
    routineDates.set(routine.id, dates);
    return dates;
  };

  const eventOccurrenceDates = (event: CalendarEvent): readonly LocalDate[] => {
    const known = eventDates.get(event.id);
    if (known !== undefined) return known;
    const dates =
      event.deletedAt === null && isLocalDate(event.startDate) && isLocalDate(event.endDate)
        ? occurrenceStarts(event, today, searchEnd).filter((date) => date >= today && date <= searchEnd)
        : [];
    eventDates.set(event.id, dates);
    return dates;
  };

  for (const reminder of reminders) {
    const { offsetMin } = reminder;
    if (reminder.targetType === 'task') {
      const task = tasks.get(reminder.targetId);
      if (task === undefined || task.deletedAt !== null || task.status !== 'todo' || task.someday || task.date === null) continue;
      const scheduledAt = fireAtOf(task.date, task.time, offsetMin);
      const fireAt = scheduledAt === null ? null : effectiveOf(task.spaceId, scheduledAt);
      if (scheduledAt === null || fireAt === null) continue;
      candidates.push({
        kind: 'task',
        id: taskNotificationId(reminder.id),
        reminderId: reminder.id,
        offsetMin,
        spaceId: task.spaceId,
        targetId: task.id,
        occurrenceDate: task.date,
        scheduledAt,
        fireAt,
      });
    } else if (reminder.targetType === 'routine') {
      const routine = routines.get(reminder.targetId);
      if (routine === undefined || routine.time === null) continue;
      // Une seule occurrence par avance : la première dont l'échéance effective est à venir (critère 12).
      for (const date of routineEligibleDates(routine)) {
        const scheduledAt = fireAtOf(date, routine.time, offsetMin);
        const fireAt = scheduledAt === null ? null : effectiveOf(routine.spaceId, scheduledAt, true);
        if (scheduledAt === null || fireAt === null) continue;
        candidates.push({
          kind: 'routine',
          id: routineNotificationId(reminder.id, date),
          reminderId: reminder.id,
          offsetMin,
          spaceId: routine.spaceId,
          targetId: routine.id,
          occurrenceDate: date,
          scheduledAt,
          fireAt,
        });
        break;
      }
    } else {
      const event = events.get(reminder.targetId);
      if (event === undefined) continue;
      // Une notification par occurrence et par avance, sans ligne `reminder` par occurrence (critères 15 à 17).
      for (const date of eventOccurrenceDates(event)) {
        const scheduledAt = fireAtOf(date, eventReminderTime(event), offsetMin);
        const fireAt = scheduledAt === null ? null : effectiveOf(event.spaceId, scheduledAt, true);
        if (scheduledAt === null || fireAt === null) continue;
        candidates.push({
          kind: 'event',
          id: eventNotificationId(reminder.id, date),
          reminderId: reminder.id,
          offsetMin,
          spaceId: event.spaceId,
          targetId: event.id,
          occurrenceDate: date,
          scheduledAt,
          fireAt,
        });
      }
    }
  }

  // Récapitulatifs : ni plage silencieuse ni filtre d'espace ; contenu pour aujourd'hui seulement (critères 11, 18, 19).
  const recapKinds: readonly RecapKind[] = ['morning', 'evening'];
  for (const recapKind of recapKinds) {
    const setting = input.recaps[recapKind];
    if (!setting.enabled || !isLocalTime(setting.time)) continue;
    for (let day = today; day <= horizonEnd; day = addDays(day, 1)) {
      const fireAt = `${day}T${setting.time}` as LocalDateTime;
      if (fireAt <= nowMinute) continue;
      candidates.push({
        kind: 'recap',
        id: recapNotificationId(recapKind, day),
        recapKind,
        day,
        fireAt,
        content: day === today ? buildRecap(recapKind, day, input.tasks, input.routines, input.routineLogs, input.routinePauses) : null,
      });
    }
  }

  if (candidates.length === 0) return EMPTY_PLAN;
  candidates.sort(comparePlanned);
  const items = candidates.slice(0, limit);
  const last = items[items.length - 1];
  const coverage: PlanCoverage =
    candidates.length <= limit
      ? { state: 'complete' }
      : // Plafond à 0 : rien n'est planifié, la couverture s'arrête à `now`.
        { state: 'until', until: last === undefined ? (nowMinute as LocalDateTime) : last.fireAt };
  return { items, coverage, total: candidates.length };
}
