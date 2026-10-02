import type { Routine, RoutineLog, RoutinePause, SettingsValues, Task } from './model';
import { groupDoneDates, pausesByRoutine, routinesForDay } from './routineSchedule';
import { compareTodayRows, rowIsDone, rowTime, type TodayRow } from './todayList';
import { isLocalTime, type LocalDate, type LocalTime, type Result } from './types';

/**
 * Récapitulatifs du matin et du soir (N-04). Ordre 1 : réglages et calcul du contenu seulement ; l'envoi est sur l'iPhone, à
 * l'ordre 5 (N-05). Ils ne dépendent d'aucun espace (filtre « Tout », plages silencieuses ES-07 non appliquées).
 */

export type RecapKind = 'morning' | 'evening';
export type RecapSetting = SettingsValues['reminders.morningRecap'];

export interface RecapSettings {
  readonly morning: RecapSetting;
  readonly evening: RecapSetting;
}

export type RecapSettingsError = 'invalid-time' | 'evening-before-morning';

/**
 * Valide les deux réglages : heures HH:MM (24 h) et soir strictement après matin (N-04 critère 4) — contrôle toujours appliqué,
 * même désactivé, car l'heure reste enregistrée.
 */
export function validateRecapSettings(settings: RecapSettings): Result<RecapSettings, RecapSettingsError> {
  if (!isLocalTime(settings.morning.time) || !isLocalTime(settings.evening.time)) return { ok: false, error: 'invalid-time' };
  if (settings.evening.time <= settings.morning.time) return { ok: false, error: 'evening-before-morning' };
  return { ok: true, value: settings };
}

/** Heures des récapitulatifs actifs, matin d'abord (ligne Réglages : « 07:30 · 21:00 ») ; vide : « Désactivés ». */
export function activeRecapTimes(settings: RecapSettings): LocalTime[] {
  return [settings.morning, settings.evening].filter((recap) => recap.enabled).map((recap) => recap.time);
}

/** Ligne d'un récapitulatif : une tâche ou une routine du jour. */
export interface RecapLine {
  readonly kind: 'task' | 'routine';
  readonly id: string;
  readonly title: string;
  readonly time: LocalTime | null;
  readonly done: boolean;
}

export interface Recap {
  readonly kind: RecapKind;
  readonly day: LocalDate;
  /** Nombre de lignes : l'ordre 5 en fait le titre (« 5 éléments aujourd'hui », « Tout est fait » à zéro, textes dans src/i18n). */
  readonly count: number;
  readonly lines: readonly RecapLine[];
}

/**
 * Contenu d'un récapitulatif (N-04 critères 5, 6) : le matin, tous les éléments du jour (tâches et routines prévues, faits compris,
 * même si A-03 masque les routines de la liste) ; le soir, seulement ceux qui ne sont pas faits. Tous espaces confondus. Une tâche
 * « Un jour » ou supprimée n'en fait pas partie ; une routine en pause ou archivée non plus. Ordre : à l'heure d'abord, par heure.
 */
export function buildRecap(
  kind: RecapKind,
  day: LocalDate,
  tasks: readonly Task[],
  routines: readonly Routine[],
  logs: readonly RoutineLog[],
  pauses: readonly RoutinePause[] = [],
): Recap {
  const rows: TodayRow[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.deletedAt !== null || task.someday || task.date !== day || seen.has(task.id)) continue;
    seen.add(task.id);
    rows.push({ kind: 'task', id: task.id, task });
  }
  const doneByRoutine = groupDoneDates(logs.filter((log) => log.deletedAt === null));
  for (const entry of routinesForDay(routines, doneByRoutine, day, pausesByRoutine(pauses))) {
    if (seen.has(entry.routine.id)) continue;
    seen.add(entry.routine.id);
    rows.push({ kind: 'routine', id: entry.routine.id, routine: entry.routine, done: entry.done });
  }
  const lines: RecapLine[] = rows
    .filter((row) => kind === 'morning' || !rowIsDone(row))
    .sort(compareTodayRows)
    .map((row) => ({
      kind: row.kind,
      id: row.id,
      title: row.kind === 'task' ? row.task.title : row.routine.title,
      time: rowTime(row),
      done: rowIsDone(row),
    }));
  return { kind, day, count: lines.length, lines };
}
