import type { ItemFilter } from './itemFilter';
import type { Goal, FocusSession, Routine, RoutineLog, RoutinePause } from './model';
import type { IsoDateTime, LocalDate } from './types';

/**
 * Export de l'historique (H-03) : lignes de tâches lues par blocs en base, CSV (séparateur « ; », UTF-8 avec BOM pour Excel) et JSON.
 * Fonctions pures ; l'enregistrement du fichier est dans `src/platform/files`.
 */

/** Version du format du fichier JSON exporté (distincte de la version du schéma SQLite). */
export const EXPORT_SCHEMA_VERSION = 1;

/** Marque d'ordre des octets UTF-8 : Excel ouvre ainsi le CSV avec les accents corrects. */
export const CSV_BOM = '﻿';
export const CSV_SEPARATOR = ';';

/** En-têtes du CSV : les six premières colonnes sont le format d'import de P-07. Identifiants de format, jamais traduits. */
export const CSV_HEADERS = ['titre', 'date', 'heure', 'espace', 'projet', 'note', 'statut', 'termine_le', 'objectif', 'repetition'] as const;

/** Valeurs de la colonne `statut`. */
export const CSV_STATUS = { todo: 'à faire', done: 'fait' } as const;

/** Règle de récurrence telle que lue en base (colonnes de `recurrence`). */
export interface ExportRecurrence {
  readonly freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  readonly interval: number;
  readonly weekdays: readonly number[];
  readonly monthDay: number | null;
  readonly nthWeekday: { readonly nth: number; readonly weekday: number } | null;
  readonly until: LocalDate | null;
  readonly count: number | null;
}

/** Une tâche à exporter, avec les noms de son espace, projet et objectif (lus par jointure). */
export interface ExportTask {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly date: LocalDate | null;
  readonly time: string | null;
  readonly status: 'todo' | 'done';
  readonly doneAt: IsoDateTime | null;
  readonly someday: boolean;
  readonly spaceId: string;
  readonly spaceName: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly goalId: string | null;
  readonly goalTitle: string | null;
  readonly recurrence: ExportRecurrence | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Date locale (fuseau de l'appareil) d'un instant UTC : 'AAAA-MM-JJ'. */
export function localDateOfInstant(instant: string): LocalDate {
  const date = new Date(instant);
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` as LocalDate;
}

const WEEKDAY_CODES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * Règle de répétition en code stable (colonne `repetition`) : « daily », « weekly/2/mon,wed », « monthly/1/day15 », « monthly/1/2mon »,
 * « yearly », suivie de « until=AAAA-MM-JJ » ou « count=N ». Vide sans répétition.
 */
export function recurrenceCode(rule: ExportRecurrence | null): string {
  if (!rule) return '';
  const parts: string[] = [rule.freq, String(rule.interval)];
  if (rule.freq === 'weekly' && rule.weekdays.length > 0) parts.push(rule.weekdays.map((day) => WEEKDAY_CODES[day - 1] ?? String(day)).join(','));
  if (rule.freq === 'monthly') {
    if (rule.nthWeekday) parts.push(`${String(rule.nthWeekday.nth)}${WEEKDAY_CODES[rule.nthWeekday.weekday - 1] ?? ''}`);
    else if (rule.monthDay !== null) parts.push(`day${String(rule.monthDay)}`);
  }
  if (rule.until) parts.push(`until=${rule.until}`);
  else if (rule.count !== null) parts.push(`count=${String(rule.count)}`);
  return parts.join('/');
}

/**
 * Une cellule dont le début serait lu comme une formule par un tableur (« = », « + », « @ », tabulation, retour chariot) est précédée d'une
 * apostrophe (injection de formule CSV). Le signe « - » seul n'est pas touché (« -5 degrés », « - point » restent tels quels).
 */
function neutralizeFormula(value: string): string {
  return /^[=+@\t\r]/.test(value) ? `'${value}` : value;
}

/** Cellule CSV : guillemets doublés, entourée de guillemets si elle contient « ; », un guillemet ou un retour à la ligne (conservé). */
export function csvCell(value: string): string {
  const safe = neutralizeFormula(value);
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(CSV_SEPARATOR);
}

/** Ligne de CSV d'une tâche (même ordre que `CSV_HEADERS`). */
export function taskCsvCells(task: ExportTask): string[] {
  return [
    task.title,
    task.date ?? '',
    task.time ?? '',
    task.spaceName,
    task.projectName ?? '',
    task.note,
    CSV_STATUS[task.status],
    task.doneAt ? localDateOfInstant(task.doneAt) : '',
    task.goalTitle ?? '',
    recurrenceCode(task.recurrence),
  ];
}

/** En-tête précédé de la BOM, fin de ligne CRLF (Excel). */
export function csvHeader(): string {
  return `${CSV_BOM}${csvRow(CSV_HEADERS)}\r\n`;
}

/** Un bloc de lignes (une par tâche), chacune terminée par CRLF : permet d'écrire par blocs. */
export function csvChunk(tasks: readonly ExportTask[]): string {
  return tasks.map((task) => `${csvRow(taskCsvCells(task))}\r\n`).join('');
}

/** CSV complet (en-tête et toutes les lignes). */
export function tasksToCsv(tasks: readonly ExportTask[]): string {
  return csvHeader() + csvChunk(tasks);
}

/** Suffixe de nom de fichier d'un espace : « Pro » donne « -pro » (minuscules, sans accents, tirets). */
export function filterFileSuffix(spaceName: string | null): string {
  if (spaceName === null) return '';
  const slug = spaceName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? '' : `-${slug}`;
}

export type ExportKind = 'csv' | 'json' | 'pdf' | 'png';

/** Nom du fichier proposé : `circletasks-taches-AAAA-MM-JJ[-pro].csv`, `circletasks-historique-…json`, `circletasks-rapport-AAAA-MM[-pro].pdf|png`. */
export function exportFileName(kind: ExportKind, input: { readonly today: LocalDate; readonly month: { readonly year: number; readonly month: number }; readonly spaceName: string | null }): string {
  const suffix = filterFileSuffix(input.spaceName);
  const month = `${String(input.month.year).padStart(4, '0')}-${pad(input.month.month)}`;
  switch (kind) {
    case 'csv':
      return `circletasks-taches-${input.today}${suffix}.csv`;
    case 'json':
      return `circletasks-historique-${input.today}${suffix}.json`;
    case 'pdf':
      return `circletasks-rapport-${month}${suffix}.pdf`;
    case 'png':
      return `circletasks-rapport-${month}${suffix}.png`;
  }
}

export const EXPORT_MIME: { readonly [K in ExportKind]: string } = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
};

export interface ExportHistoryInput {
  readonly exportedAt: IsoDateTime;
  readonly filter: ItemFilter;
  readonly spaceName: string | null;
  readonly projectName: string | null;
  /** Période exportée : tout l'historique ou un mois (bornes de dates locales). */
  readonly period: { readonly kind: 'all' } | { readonly kind: 'month'; readonly from: LocalDate; readonly to: LocalDate };
  readonly tasks: readonly ExportTask[];
  readonly routines: readonly Routine[];
  readonly routineLogs: readonly RoutineLog[];
  readonly routinePauses: readonly RoutinePause[];
  readonly focusSessions: readonly FocusSession[];
  readonly goals: readonly Goal[];
}

/**
 * Contenu du JSON (H-03 critère 3) : `{ schema_version, exported_at, filter, tasks, routines, focus_sessions, goals }`. Identifiants
 * stables, instants en UTC, dates locales ; aucun jeton ni réglage. Les routines portent leurs validations et leurs pauses.
 */
export function historyToJson(input: ExportHistoryInput): Record<string, unknown> {
  const logsOf = (routineId: string) => input.routineLogs.filter((log) => log.routineId === routineId).map((log) => ({ id: log.id, date: log.date, done_at: log.doneAt }));
  const pausesOf = (routineId: string) =>
    input.routinePauses.filter((pause) => pause.routineId === routineId).map((pause) => ({ id: pause.id, from_date: pause.fromDate, to_date: pause.toDate }));
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: input.exportedAt,
    filter: {
      space_id: input.filter.space === 'all' ? null : input.filter.space,
      space: input.spaceName,
      project_id: input.filter.project,
      project: input.projectName,
      period: input.period.kind === 'all' ? { kind: 'all' } : { kind: 'month', from: input.period.from, to: input.period.to },
    },
    tasks: input.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      note: task.note,
      date: task.date,
      time: task.time,
      status: task.status,
      done_at: task.doneAt,
      done_date: task.doneAt ? localDateOfInstant(task.doneAt) : null,
      someday: task.someday,
      space_id: task.spaceId,
      space: task.spaceName,
      project_id: task.projectId,
      project: task.projectName,
      goal_id: task.goalId,
      goal: task.goalTitle,
      recurrence: task.recurrence
        ? {
            freq: task.recurrence.freq,
            interval: task.recurrence.interval,
            weekdays: task.recurrence.weekdays,
            month_day: task.recurrence.monthDay,
            nth_weekday: task.recurrence.nthWeekday,
            until: task.recurrence.until,
            count: task.recurrence.count,
          }
        : null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    })),
    routines: input.routines.map((routine) => ({
      id: routine.id,
      title: routine.title,
      space_id: routine.spaceId,
      schedule_type: routine.scheduleType,
      weekdays: routine.weekdays,
      times_per_week: routine.timesPerWeek,
      interval: routine.interval,
      start_date: routine.startDate,
      time: routine.time,
      paused: routine.paused,
      archived: routine.archived,
      logs: logsOf(routine.id),
      pauses: pausesOf(routine.id),
    })),
    focus_sessions: input.focusSessions.map((session) => ({
      id: session.id,
      task_id: session.taskId,
      space_id: session.spaceId,
      project_id: session.projectId,
      planned_min: session.plannedMin,
      started_at: session.startedAt,
      started_date: localDateOfInstant(session.startedAt),
      ended_at: session.endedAt,
      paused_sec: session.pausedSec,
    })),
    goals: input.goals.map((goal) => ({ id: goal.id, space_id: goal.spaceId, week_start: goal.weekStart, title: goal.title, status: goal.status, pinned: goal.pinned })),
  };
}
