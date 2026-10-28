import { compareTodayRows, rowIsDone, rowTime, type TodayEventEntry, type TodayList, type TodayRow } from './todayList';
import type { LocalTime } from './types';

/**
 * Agenda du jour (UI-REFONTE-02, docs/maquettes-refonte/Jour.html) : les lignes d'Aujourd'hui placées sur la colonne des heures.
 *
 * Le jour courant, la ligne « maintenant » s'insère à l'heure courante : ce qui est avant recule (`past`), une tâche à l'heure non
 * faite dont l'heure est passée est **due** et se place juste avant « maintenant », ce qui suit est à venir (`upcoming`), les
 * éléments sans heure viennent après tout le reste (`untimed`, ordre manuel, faits en fin de groupe). Les événements de la journée
 * entière ouvrent l'agenda (`allDay`). Un autre jour (ou sans heure courante) : pas de « maintenant », rien de passé ni de dû.
 * Les objectifs et les checklists ne sont pas des lignes de l'agenda : l'écran les place à part.
 */

export type AgendaPhase = 'allDay' | 'past' | 'due' | 'upcoming' | 'untimed';

export type AgendaLine =
  | { readonly kind: 'row'; readonly id: string; readonly row: TodayRow; readonly time: LocalTime | null; readonly phase: AgendaPhase; readonly lateMinutes: number | null }
  | { readonly kind: 'event'; readonly id: string; readonly event: TodayEventEntry; readonly time: LocalTime | null; readonly phase: AgendaPhase }
  | { readonly kind: 'now'; readonly id: 'now'; readonly time: LocalTime };

const minutesOf = (time: LocalTime): number => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Minutes écoulées entre l'heure d'une ligne et l'heure courante (0 à l'heure exacte). */
export function lateMinutes(time: LocalTime, now: LocalTime): number {
  return minutesOf(now) - minutesOf(time);
}

type Timed = Exclude<AgendaLine, { kind: 'now' }> & { readonly time: LocalTime };

/** À heure égale : événement, puis routine, puis tâches dans l'ordre manuel (`compareTodayRows`). */
function compareTimed(a: Timed, b: Timed): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'event' ? -1 : 1;
  if (a.kind === 'event' && b.kind === 'event') return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (a.kind === 'row' && b.kind === 'row') return compareTodayRows(a.row, b.row);
  return 0;
}

export function buildTodayAgenda(list: TodayList, now: LocalTime | null): AgendaLine[] {
  const rows: TodayRow[] = [...list.rows, ...list.doneRows];
  const allDay: AgendaLine[] = [];
  const timed: Timed[] = [];
  const untimed: TodayRow[] = [];

  for (const event of list.events) {
    const time = event.allDay ? null : event.startTime;
    if (time === null) allDay.push({ kind: 'event', id: event.id, event, time: null, phase: 'allDay' });
    else timed.push({ kind: 'event', id: event.id, event, time, phase: 'upcoming' });
  }
  for (const row of rows) {
    const time = rowTime(row);
    if (time === null) untimed.push(row);
    else timed.push({ kind: 'row', id: row.id, row, time, phase: 'upcoming', lateMinutes: null });
  }
  timed.sort(compareTimed);

  const lines: AgendaLine[] = [...allDay];
  if (now === null) {
    lines.push(...timed);
  } else {
    const past: AgendaLine[] = [];
    const due: AgendaLine[] = [];
    const upcoming: AgendaLine[] = [];
    for (const line of timed) {
      if (line.time >= now) {
        upcoming.push(line);
      } else if (line.kind === 'row' && line.row.kind === 'task' && !rowIsDone(line.row)) {
        due.push({ ...line, phase: 'due', lateMinutes: lateMinutes(line.time, now) });
      } else {
        past.push({ ...line, phase: 'past' });
      }
    }
    lines.push(...past, ...due, { kind: 'now', id: 'now', time: now }, ...upcoming);
  }

  // Sans heure : à faire dans l'ordre manuel, puis faits (même ordre) ; `list.rows` et `list.doneRows` sont déjà triés ainsi.
  const pending = untimed.filter((row) => !rowIsDone(row));
  const done = untimed.filter(rowIsDone);
  for (const row of [...pending, ...done]) lines.push({ kind: 'row', id: row.id, row, time: null, phase: 'untimed', lateMinutes: null });
  return lines;
}
