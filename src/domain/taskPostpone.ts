import type { TaskStatus } from './model';
import { addDays } from './localDate';
import { scheduleOf, type ScheduleFields } from './taskSchedule';
import { isLocalDate, type LocalDate, type Result } from './types';

/**
 * Report d'une tâche (T-05, décision Q4 du 2026-10-02). Tout se calcule depuis la
 * date du jour, jamais depuis la date de la tâche :
 * - « Demain » = aujourd'hui + 1 jour ;
 * - « Semaine prochaine » = lundi de la semaine (lundi-dimanche) qui suit aujourd'hui,
 *   y compris un dimanche (dimanche 27 sept. -> lundi 28 sept.) ;
 * - « Choisir une date » = date validée dans le sélecteur.
 * L'heure flottante est conservée telle quelle. Calculs en UTC sur des dates civiles :
 * aucun effet de fuseau ni de changement d'heure.
 */
export type PostponeTarget = 'tomorrow' | 'next-week' | { readonly date: LocalDate };

export type PostponeError = 'already-done' | 'invalid-date';

function toUtcMs(date: LocalDate): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** « Demain » : aujourd'hui + 1 jour. */
export function nextDayFrom(today: LocalDate): LocalDate {
  return addDays(today, 1);
}

/** « Semaine prochaine » : le lundi qui suit strictement `today` (un lundi donne le lundi suivant). */
export function nextWeekFrom(today: LocalDate): LocalDate {
  const isoWeekday = ((new Date(toUtcMs(today)).getUTCDay() + 6) % 7) + 1; // 1 = lundi … 7 = dimanche
  return addDays(today, 8 - isoWeekday);
}

/** Date visée par un report, ou `'invalid-date'` si la date choisie n'existe pas. */
export function resolvePostponeDate(today: LocalDate, target: PostponeTarget): Result<LocalDate, 'invalid-date'> {
  if (target === 'tomorrow') return { ok: true, value: nextDayFrom(today) };
  if (target === 'next-week') return { ok: true, value: nextWeekFrom(today) };
  return isLocalDate(target.date) ? { ok: true, value: target.date } : { ok: false, error: 'invalid-date' };
}

/**
 * Nouvelle planification d'une tâche reportée : date remplacée, heure conservée,
 * « Un jour » levé (planifier, SD-02). Une tâche terminée n'est pas reportable
 * (critère 9). Ne touche jamais `carriedOver` (critère 7, réservé à T-06).
 */
export function postponeTask(
  task: ScheduleFields & { readonly status: TaskStatus },
  today: LocalDate,
  target: PostponeTarget,
): Result<ScheduleFields, PostponeError> {
  if (task.status === 'done') return { ok: false, error: 'already-done' };
  const date = resolvePostponeDate(today, target);
  if (!date.ok) return date;
  return { ok: true, value: { date: date.value, time: scheduleOf(task).time, someday: false } };
}
