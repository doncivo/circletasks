import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { RecurrenceFields, Space } from '../../domain/model';
import { rowTime, type TodayRow } from '../../domain/todayList';
import type { LocalDate, RecurrenceId, RoutineId, TaskId } from '../../domain/types';
import type { WeekDay } from '../../domain/week';
import { t } from '../../i18n';
import { formatDayFull, formatDropDayLabel, formatWeekDayHeader } from '../../i18n/format';
import { ListSkeleton, type Layout } from '../../ui';
import { WeekDayAdd } from './WeekDayAdd';
import { WeekEventItem, WeekRoutineItem, WeekTaskItem } from './WeekItems';

/** Ce que le jour montre pendant un glisser : zone « Déposer ici » (autre jour) ou repère d'insertion (même jour, A-02). */
export type WeekDropState = { readonly kind: 'move' } | { readonly kind: 'reorder'; readonly index: number; readonly draggedId: TaskId };

export interface WeekItemDragProps {
  readonly 'data-drag-id': string;
  readonly 'data-dragging': 'true' | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

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
  /** Glisser (S-02) : propriétés de saisie d'une tâche ; absent : aucune carte n'est déplaçable. */
  readonly dragProps?: (id: TaskId) => WeekItemDragProps;
  /** Glisser en cours au-dessus de ce jour. */
  readonly drop?: WeekDropState | null;
  readonly onFocusTask?: (id: TaskId) => void;
  readonly onToggleDone: (id: TaskId) => void;
  readonly onToggleRoutine: (id: RoutineId, date: LocalDate) => void;
  readonly onOpen: (id: TaskId) => void;
  /** S-04 : ajout rapide en bas du jour ; crée la tâche de ce jour et rend true si elle l'est. */
  readonly onAddTask?: (date: LocalDate, title: string) => Promise<boolean>;
}

/**
 * Un jour de la Semaine : colonne (PC) ou section (iPhone), aussi zone de dépôt du glisser (`data-drop-zone`). Contenu dans l'ordre
 * du domaine : événements en tête, éléments à faire (heure puis ordre manuel), terminés ; le bas du jour reste visible quand la
 * colonne défile (S-01 critère 9).
 */
export function WeekDayView(props: WeekDayViewProps) {
  const { day, layout, isToday, skeleton, drop } = props;
  const itemsRef = useRef<HTMLDivElement>(null);
  const header = formatWeekDayHeader(day.date);
  const full = formatDayFull(day.date);
  const label = isToday ? t('week.dayAriaToday', { day: full }) : full;

  // Autres tâches du jour dans l'ordre affiché : le repère d'insertion se place avant celle que vise le pointeur.
  const taskIds = [...day.list.rows, ...day.list.doneRows].filter((row) => row.kind === 'task').map((row) => row.id);
  const insertBefore = drop?.kind === 'reorder' ? (taskIds.filter((id) => id !== drop.draggedId)[drop.index] ?? null) : null;

  const renderRow = (row: TodayRow) => {
    if (row.kind === 'routine') {
      return (
        <WeekRoutineItem
          key={row.id}
          routine={row.routine}
          time={rowTime(row)}
          done={row.done}
          layout={layout}
          checkable={props.routinesCheckable}
          onToggle={() => props.onToggleRoutine(row.routine.id as RoutineId, day.date)}
        />
      );
    }
    const id = row.task.id;
    return (
      <div
        key={row.id}
        className="ct-week__itemSlot"
        data-task-id={id}
        data-insert={insertBefore === id ? 'before' : undefined}
        onFocus={() => props.onFocusTask?.(id)}
        {...props.dragProps?.(id)}
      >
        <WeekTaskItem
          task={row.task}
          layout={layout}
          spaces={props.spaces}
          showSpace={props.showSpace}
          rule={row.task.recurrenceId ? props.recurrences.get(row.task.recurrenceId) : undefined}
          opened={props.openedTaskId === id}
          onToggleDone={() => props.onToggleDone(id)}
          onOpen={() => props.onOpen(id)}
        />
      </div>
    );
  };

  return (
    <section
      role="group"
      className="ct-week-day"
      data-layout={layout}
      data-today={isToday || undefined}
      data-date={day.date}
      data-drop-zone={day.date}
      data-drop={drop?.kind}
      aria-label={label}
      {...(isToday ? { 'aria-current': 'date' as const } : {})}
    >
      <div className="ct-week-day__head">
        <span className="ct-week-day__weekday" aria-hidden="true">
          {header.weekday}
        </span>
        <span className="ct-week-day__number" aria-hidden="true">
          {header.day}
        </span>
      </div>
      <div className="ct-week-day__body">
        <div ref={itemsRef} className="ct-week-day__items">
          {skeleton ? (
            <ListSkeleton rows={layout === 'pc' ? 2 : 1} />
          ) : (
            <>
              {day.list.events.map((event) => (
                <WeekEventItem key={event.id} event={event} layout={layout} />
              ))}
              {day.list.rows.map(renderRow)}
              {day.list.doneRows.map(renderRow)}
              {drop?.kind === 'reorder' && insertBefore === null && <div className="ct-week__insert" aria-hidden="true" />}
            </>
          )}
          {drop?.kind === 'move' && (
            <div className="ct-week__dropHere" aria-hidden="true">
              {t('week.dropHere', { day: formatDropDayLabel(day.date) })}
            </div>
          )}
        </div>
        {props.onAddTask && (
          <WeekDayAdd
            date={day.date}
            layout={layout}
            onAdd={(title) => props.onAddTask?.(day.date, title) ?? Promise.resolve(false)}
            // La colonne défile jusqu'à la nouvelle carte (PC : colonne à défilement interne).
            onAdded={() =>
              window.requestAnimationFrame(() => {
                if (itemsRef.current) itemsRef.current.scrollTop = itemsRef.current.scrollHeight;
              })
            }
          />
        )}
      </div>
    </section>
  );
}
