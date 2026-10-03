import type { Task } from './model';
import { matchesItemFilter, type ItemFilter } from './itemFilter';
import { moveTaskToDate } from './taskMove';
import { addDays } from './localDate';
import { isLocalDate, isLocalTime, type LocalDate, type LocalTime, type Result } from './types';

/**
 * Liste « Un jour » (M18, SD-01 à SD-04, S-06) : tâches sans date à planifier plus tard. Invariant du modèle (`task.ts`) :
 * `someday = true` ⇒ aucune date ni heure. Règles pures partagées par l'écran iPhone, le panneau PC (Aujourd'hui, Semaine)
 * et le compteur de l'icône horloge.
 */

/** Une tâche appartient à la liste « Un jour » affichée : à faire, non supprimée, dans l'espace et le projet filtrés. */
export function isInSomedayList(task: Task, filter: ItemFilter): boolean {
  return task.someday && task.status === 'todo' && task.deletedAt === null && matchesItemFilter(task, filter);
}

/** Ordre manuel de la liste (`sortOrder`, puis identifiant pour un ordre stable). */
export function compareSomedayTasks(a: Task, b: Task): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Tâches de la liste « Un jour » pour le filtre donné, dans l'ordre manuel. */
export function selectSomedayTasks(tasks: Iterable<Task>, filter: ItemFilter): Task[] {
  const selected: Task[] = [];
  for (const task of tasks) if (isInSomedayList(task, filter)) selected.push(task);
  return selected.sort(compareSomedayTasks);
}

/**
 * `sortOrder` qui place une tâche en tête de la liste (SD-04 critère 2 ; SD-03 critère 1 : la tâche renvoyée entre en tête).
 * `existing` : ordres des tâches « Un jour » déjà présentes ; `fallback` : valeur de départ quand la liste est vide.
 */
export function somedayHeadOrder(existing: readonly number[], fallback: number): number {
  return existing.length === 0 ? fallback : Math.min(...existing) - 1;
}

/** Planification choisie pour une tâche « Un jour » : jour de la liste ou date choisie (heure facultative). */
export interface ScheduleSomedayPlan {
  readonly date: LocalDate;
  readonly time: LocalTime | null;
  readonly someday: false;
  readonly carriedOver: false;
  readonly sortOrder: number;
}

export type ScheduleSomedayError = 'not-someday' | 'invalid-date' | 'invalid-time';

/**
 * Planifie une tâche « Un jour » (SD-02, S-06) : `someday` levé, date posée, heure facultative (sans heure, les rappels restent
 * inactifs, QB-10). La tâche prend la fin de l'ordre manuel du jour d'arrivée (`lastSortOrder`, comme S-02). Refuse une tâche qui
 * n'est pas dans « Un jour » ou terminée, une date ou une heure invalide.
 */
export function scheduleSomeday(
  task: Pick<Task, 'someday' | 'status' | 'sortOrder'>,
  date: LocalDate,
  time: LocalTime | null,
  lastSortOrder: number | null,
): Result<ScheduleSomedayPlan, ScheduleSomedayError> {
  if (!task.someday || task.status !== 'todo') return { ok: false, error: 'not-someday' };
  if (!isLocalDate(date)) return { ok: false, error: 'invalid-date' };
  if (time !== null && !isLocalTime(time)) return { ok: false, error: 'invalid-time' };
  const moved = moveTaskToDate({ date: null, someday: task.someday, sortOrder: task.sortOrder }, date, lastSortOrder);
  if (!moved.ok) return { ok: false, error: 'invalid-date' };
  return { ok: true, value: { ...moved.value, time } };
}

/** Choix de planification d'une tâche « Un jour » (SD-02) : boutons « Aujourd'hui » et « Demain », ou date (heure facultative) choisie. */
export type ScheduleSomedayTarget = 'today' | 'tomorrow' | { readonly date: LocalDate; readonly time?: LocalTime | null };

/** Date et heure visées, calculées depuis aujourd'hui (comme le report, Q4) ; « Aujourd'hui » et « Demain » n'ont pas d'heure. */
export function resolveScheduleTarget(today: LocalDate, target: ScheduleSomedayTarget): { readonly date: LocalDate; readonly time: LocalTime | null } {
  if (target === 'today') return { date: today, time: null };
  if (target === 'tomorrow') return { date: addDays(today, 1), time: null };
  return { date: target.date, time: target.time ?? null };
}

/** Libellé du message « Annuler » : « pour aujourd'hui », « pour demain », ou « au jeu. 24 sept. » pour toute autre date. */
export function scheduleLabelKind(today: LocalDate, date: LocalDate): 'today' | 'tomorrow' | 'date' {
  if (date === today) return 'today';
  return date === addDays(today, 1) ? 'tomorrow' : 'date';
}
