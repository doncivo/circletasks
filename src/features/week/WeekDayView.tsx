import type { ReactNode } from 'react';
import type { RecurrenceFields, Space } from '../../domain/model';
import { rowTime, type TodayRow } from '../../domain/todayList';
import type { LocalDate, RecurrenceId, RoutineId, TaskId } from '../../domain/types';
import type { WeekDay } from '../../domain/week';
import { t } from '../../i18n';
import { formatDayFull, formatWeekDayHeader } from '../../i18n/format';
import { ListSkeleton, type Layout } from '../../ui';
import { WeekEventItem, WeekRoutineItem, WeekTaskItem } from './WeekItems';

export interface WeekDayViewProps {
  readonly day: WeekDay;
  readonly layout: Layout;
  /** Jour courant : fond #F3F1F6, libellé et numéro en #1F6698, annoncé « aujourd'hui » (S-01 critère 3). */
  readonly isToday: boolean;
  readonly spaces: readonly Space[];
  readonly showSpace: boolean;
  readonly recurrences: ReadonlyMap<RecurrenceId, RecurrenceFields>;
  readonly routinesCheckable: boolean;
  readonly openedTaskId: TaskId | null;
  /** Squelette de chargement (A-09) à la place des éléments. */
  readonly skeleton: boolean;
  readonly onToggleDone: (id: TaskId) => void;
  readonly onToggleRoutine: (id: RoutineId, date: LocalDate) => void;
  readonly onOpen: (id: TaskId) => void;
  /** Bas du jour : « + Ajouter » (S-04). */
  readonly footer?: ReactNode;
}

/**
 * Un jour de la Semaine : colonne (PC) ou section (iPhone). Contenu dans l'ordre du domaine : événements en tête, éléments à
 * faire (heure puis ordre manuel), terminés ; le bas du jour reste visible quand la colonne défile (S-01 critère 9).
 */
export function WeekDayView(props: WeekDayViewProps) {
  const { day, layout, isToday, skeleton } = props;
  const header = formatWeekDayHeader(day.date);
  const full = formatDayFull(day.date);
  const label = isToday ? t('week.dayAriaToday', { day: full }) : full;

  const renderRow = (row: TodayRow) =>
    row.kind === 'routine' ? (
      <WeekRoutineItem
        key={row.id}
        routine={row.routine}
        time={rowTime(row)}
        done={row.done}
        layout={layout}
        checkable={props.routinesCheckable}
        onToggle={() => props.onToggleRoutine(row.routine.id as RoutineId, day.date)}
      />
    ) : (
      <div key={row.id} className="ct-week__itemSlot" data-task-id={row.task.id}>
        <WeekTaskItem
          task={row.task}
          layout={layout}
          spaces={props.spaces}
          showSpace={props.showSpace}
          rule={row.task.recurrenceId ? props.recurrences.get(row.task.recurrenceId) : undefined}
          opened={props.openedTaskId === row.task.id}
          onToggleDone={() => props.onToggleDone(row.task.id)}
          onOpen={() => props.onOpen(row.task.id)}
        />
      </div>
    );

  return (
    <section role="group" className="ct-week-day" data-layout={layout} data-today={isToday || undefined} data-date={day.date} aria-label={label} {...(isToday ? { 'aria-current': 'date' as const } : {})}>
      <div className="ct-week-day__head">
        <span className="ct-week-day__weekday" aria-hidden="true">
          {header.weekday}
        </span>
        <span className="ct-week-day__number" aria-hidden="true">
          {header.day}
        </span>
      </div>
      <div className="ct-week-day__body">
        <div className="ct-week-day__items">
          {skeleton ? (
            <ListSkeleton rows={layout === 'pc' ? 2 : 1} />
          ) : (
            <>
              {day.list.events.map((event) => (
                <WeekEventItem key={event.id} event={event} layout={layout} />
              ))}
              {day.list.rows.map(renderRow)}
              {day.list.doneRows.map(renderRow)}
            </>
          )}
        </div>
        {props.footer}
      </div>
    </section>
  );
}
