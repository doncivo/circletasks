import type { Checklist, ChecklistSummary, Goal, GoalProgress, IconRef, Routine, Task } from './model';
import { compareGoalsByCreation, pinnedGoalsForWeek } from './goalRules';
import { matchesSpaceFilter } from './spaceRules';
import { isPausedAt, type DateInterval } from './routineSchedule';
import type { Id, LocalDate, LocalTime, SpaceFilter, SpaceId } from './types';

/**
 * Assemblage de la liste d'Aujourd'hui (A-01, A-03) : composition, tri et filtre d'espace.
 *
 * Les routines (M4), événements (M7, M8) et checklists (M6) sont fournis déjà calculés pour le jour par
 * leur module (occurrences de routine, occurrences d'événement) : cette fonction ne connaît ni leur
 * planification ni leur base, elle ne fait que les placer. Une source absente = liste vide, jamais
 * d'élément simulé. Ordre vertical (A-01 critère 3) : objectif épinglé, événements, éléments à faire
 * (routines et tâches mêlées), éléments terminés, checklists.
 */

/** Routine prévue le jour affiché, avec l'état de sa validation (R-02, R-03). */
export interface TodayRoutineEntry {
  readonly routine: Routine;
  readonly done: boolean;
  /** Périodes de pause de la routine (R-05) : sans elles, le booléen `paused` fait foi. */
  readonly pauses?: readonly DateInterval[];
}

/** Événement du jour, interne (M7) ou externe lu dans un agenda (M8) ; lecture seule. */
export interface TodayEventEntry {
  readonly id: string;
  readonly title: string;
  readonly allDay: boolean;
  readonly startTime: LocalTime | null;
  /** Espace de l'événement interne ; null pour un événement externe (hors filtre d'espace). */
  readonly spaceId: SpaceId | null;
  /** Nom de l'agenda d'origine d'un événement externe (« Google Agenda »), null pour un événement interne. */
  readonly calendarName: string | null;
  readonly icon: IconRef | null;
  /** Instant de début UTC (événement externe) : départage deux événements de même heure locale (recul d'heure : 02:30 CEST puis 02:30 CET). */
  readonly startInstant?: string;
}

/** Objectif épinglé (OB-02) et son avancement (OB-04). Un encadré par objectif épinglé (QB-12). */
export interface TodayGoalEntry {
  readonly goal: Goal;
  readonly progress: GoalProgress;
}

export interface TodayListInput {
  readonly date: LocalDate;
  readonly filter: SpaceFilter;
  readonly tasks: readonly Task[];
  readonly routines?: readonly TodayRoutineEntry[];
  readonly events?: readonly TodayEventEntry[];
  readonly checklists?: readonly ChecklistSummary[];
  /** Objectifs épinglés de la semaine du jour, avec leur avancement ; le domaine garde ceux du jour et de l'espace affichés. */
  readonly goals?: readonly TodayGoalEntry[];
  /** A-03 : `today.hideRoutines`. Les routines masquées disparaissent de la liste du jour seulement. */
  readonly hideRoutines?: boolean;
}

/** Ligne de la liste mêlée : une tâche ou une routine. */
export type TodayRow =
  | { readonly kind: 'task'; readonly id: string; readonly task: Task }
  | { readonly kind: 'routine'; readonly id: string; readonly routine: Routine; readonly done: boolean };

export interface TodayList {
  /** Objectifs épinglés de la semaine et de l'espace affichés, dans l'ordre de création (un encadré chacun, QB-12). */
  readonly goals: readonly TodayGoalEntry[];
  readonly events: readonly TodayEventEntry[];
  /** Éléments à faire : à l'heure d'abord, par heure, puis sans heure (routines puis ordre manuel, Q11). */
  readonly rows: readonly TodayRow[];
  /** Éléments terminés, en bas, même tri. */
  readonly doneRows: readonly TodayRow[];
  readonly checklists: readonly ChecklistSummary[];
  /** Vrai si rien n'est prévu (tâches, routines affichées, événements, checklists) : état vide. */
  readonly isEmpty: boolean;
}

export function rowTime(row: TodayRow): LocalTime | null {
  return row.kind === 'task' ? row.task.time : row.routine.time;
}

export function rowIsDone(row: TodayRow): boolean {
  return row.kind === 'task' ? row.task.status === 'done' : row.done;
}

const inSpace = (filter: SpaceFilter, spaceId: SpaceId | null): boolean => spaceId === null || matchesSpaceFilter({ spaceId }, filter);

/**
 * Ordre d'affichage (Q11) : avec heure d'abord, par heure ; à heure égale ou sans heure, les routines
 * (non déplaçables, placées par leur heure) avant les tâches, puis ordre manuel (`sortOrder`), puis id.
 */
export function compareTodayRows(a: TodayRow, b: TodayRow): number {
  const ta = rowTime(a);
  const tb = rowTime(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta < tb ? -1 : 1;
  }
  if (a.kind !== b.kind) return a.kind === 'routine' ? -1 : 1;
  if (a.kind === 'task' && b.kind === 'task' && a.task.sortOrder !== b.task.sortOrder) return a.task.sortOrder - b.task.sortOrder;
  if (a.kind === 'routine' && b.kind === 'routine' && a.routine.title !== b.routine.title) return a.routine.title < b.routine.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEvents(a: TodayEventEntry, b: TodayEventEntry): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  // Deux événements externes à heure (non journée entière) : ordre chronologique par instant UTC, même au recul d'heure.
  if (!a.allDay && a.startInstant !== undefined && b.startInstant !== undefined && a.startInstant !== b.startInstant) return a.startInstant < b.startInstant ? -1 : 1;
  const ta = a.startTime ?? '';
  const tb = b.startTime ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Garde la première occurrence de chaque identifiant (une source qui se recoupe n'affiche pas deux fois). */
function unique<T>(items: readonly T[], idOf: (item: T) => Id | string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function checklistVisible(checklist: Checklist, date: LocalDate, filter: SpaceFilter): boolean {
  return checklist.deletedAt === null && !checklist.isTemplate && checklist.date === date && inSpace(filter, checklist.spaceId);
}

export function buildTodayList(input: TodayListInput): TodayList {
  const { date, filter } = input;
  const tasks = unique(
    input.tasks.filter((task) => task.deletedAt === null && !task.someday && task.date === date && inSpace(filter, task.spaceId)),
    (task) => task.id,
  );
  const routines = input.hideRoutines
    ? []
    : unique(
        (input.routines ?? []).filter(
          (entry) => entry.routine.deletedAt === null && !entry.routine.archived && !isPausedAt(entry.routine, date, entry.pauses ?? []) && inSpace(filter, entry.routine.spaceId),
        ),
        (entry) => entry.routine.id,
      );

  const all: TodayRow[] = [
    ...tasks.map((task): TodayRow => ({ kind: 'task', id: task.id, task })),
    ...routines.map((entry): TodayRow => ({ kind: 'routine', id: entry.routine.id, routine: entry.routine, done: entry.done })),
  ];
  const rows = all.filter((row) => !rowIsDone(row)).sort(compareTodayRows);
  const doneRows = all.filter(rowIsDone).sort(compareTodayRows);

  const events = unique(
    (input.events ?? []).filter((event) => inSpace(filter, event.spaceId)),
    (event) => event.id,
  ).sort(compareEvents);
  const checklists = unique(
    (input.checklists ?? []).filter((summary) => checklistVisible(summary.checklist, date, filter)),
    (summary) => summary.checklist.id,
  );
  const entries = unique(input.goals ?? [], (entry) => entry.goal.id);
  const shown = new Set(pinnedGoalsForWeek(entries.map((entry) => entry.goal), date, filter).map((goal) => goal.id));
  const goals = entries
    .filter((entry) => shown.has(entry.goal.id))
    .sort((a, b) => compareGoalsByCreation(a.goal, b.goal));

  return {
    goals,
    events,
    rows,
    doneRows,
    checklists,
    isEmpty: rows.length === 0 && doneRows.length === 0 && events.length === 0 && checklists.length === 0,
  };
}
