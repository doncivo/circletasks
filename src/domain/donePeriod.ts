import type { Task } from './model';
import type { IsoDateTime, LocalDate, LocalTime } from './types';
import { addDays } from './localDate';

/**
 * Périodes de consultation des tâches terminées (T-07) : jour, semaine (lundi au
 * dimanche, ISO) ou mois civil, en dates locales. `doneAt` est un instant UTC : il est
 * converti en date locale de l'appareil pour tomber dans une période, et les bornes
 * d'une période sont converties en instants UTC (minuit local) pour la requête
 * (`TaskRepository.listDone`, index sur `done_at`).
 */
export const DONE_PERIOD_KINDS = ['day', 'week', 'month'] as const;
export type DonePeriodKind = (typeof DONE_PERIOD_KINDS)[number];

/** Période affichée : bornes incluses, dates locales. */
export interface DonePeriod {
  readonly kind: DonePeriodKind;
  readonly from: LocalDate;
  readonly to: LocalDate;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function parts(date: LocalDate): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}

function fromParts(year: number, month: number, day: number): LocalDate {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}` as LocalDate;
}

/** Période de type `kind` contenant `date` (semaine : lundi au dimanche ; mois : 1er au dernier jour). */
export function donePeriodOf(kind: DonePeriodKind, date: LocalDate): DonePeriod {
  if (kind === 'day') return { kind, from: date, to: date };
  const [year, month, day] = parts(date);
  if (kind === 'week') {
    const isoWeekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1; // 1 = lundi
    const from = addDays(date, 1 - isoWeekday);
    return { kind, from, to: addDays(from, 6) };
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { kind, from: fromParts(year, month, 1), to: fromParts(year, month, lastDay) };
}

/** Période précédente (`step` = -1) ou suivante (+1) : un jour, une semaine ou un mois de décalage. */
export function shiftDonePeriod(period: DonePeriod, step: -1 | 1): DonePeriod {
  if (period.kind === 'day') return donePeriodOf('day', addDays(period.from, step));
  if (period.kind === 'week') return donePeriodOf('week', addDays(period.from, 7 * step));
  const [year, month] = parts(period.from);
  const index = year * 12 + (month - 1) + step;
  return donePeriodOf('month', fromParts(Math.floor(index / 12), (index % 12) + 1, 1));
}

/** Minuit local de `date`, en instant UTC (fuseau de l'appareil, changements d'heure compris). */
export function localMidnightIso(date: LocalDate): IsoDateTime {
  const [year, month, day] = parts(date);
  return new Date(year, month - 1, day).toISOString() as IsoDateTime;
}

/** Plage d'instants UTC de la période : `from` inclus, `to` exclu (minuit local du lendemain du dernier jour). */
export function donePeriodInstants(period: DonePeriod): { readonly from: IsoDateTime; readonly to: IsoDateTime } {
  return { from: localMidnightIso(period.from), to: localMidnightIso(addDays(period.to, 1)) };
}

/** Date locale d'un instant UTC. */
export function localDateOfInstant(iso: IsoDateTime): LocalDate {
  const d = new Date(iso);
  return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Heure locale (24 h) d'un instant UTC. */
export function localTimeOfInstant(iso: IsoDateTime): LocalTime {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}` as LocalTime;
}

export function isInDonePeriod(task: Pick<Task, 'status' | 'doneAt' | 'deletedAt'>, period: DonePeriod): boolean {
  if (task.status !== 'done' || task.doneAt === null || task.deletedAt !== null) return false;
  const day = localDateOfInstant(task.doneAt);
  return day >= period.from && day <= period.to;
}

export interface DoneDayGroup {
  readonly date: LocalDate;
  readonly tasks: readonly Task[];
}

/** Tâches terminées groupées par jour de fin (date locale), du plus récent au plus ancien, heure de fin décroissante. */
export function groupDoneByDay(tasks: readonly Task[]): DoneDayGroup[] {
  const byDay = new Map<LocalDate, Task[]>();
  for (const task of tasks) {
    if (task.doneAt === null) continue;
    const day = localDateOfInstant(task.doneAt);
    const list = byDay.get(day);
    if (list) list.push(task);
    else byDay.set(day, [task]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({
      date,
      tasks: list.sort((a, b) => (a.doneAt ?? '') < (b.doneAt ?? '') ? 1 : (a.doneAt ?? '') > (b.doneAt ?? '') ? -1 : a.id < b.id ? -1 : 1),
    }));
}
