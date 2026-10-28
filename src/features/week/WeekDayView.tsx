import { Fragment, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { weekdayOf } from '../../domain/localDate';
import type { RecurrenceFields, Space } from '../../domain/model';
import { buildTodayAgenda } from '../../domain/todayAgenda';
import { rowTime, type TodayEventEntry, type TodayRow } from '../../domain/todayList';
import type { ChecklistId, LocalDate, LocalTime, RecurrenceId, RoutineId, TaskId } from '../../domain/types';
import type { WeekDay } from '../../domain/week';
import { t } from '../../i18n';
import { formatDayFull, formatDropDayLabel, formatWeekDayHeader } from '../../i18n/format';
import { formatWeekDayLower, tWeekRefonte } from '../../i18n/weekRefonteText';
import { ListSkeleton, SwipeRow, type Layout, type RowGestureFeedback } from '../../ui';
import { taskGestureProps, type TaskGestureApi } from '../tasks/taskGestures';
import { bandCountdownTag } from '../events/bandCountdown';
import type { CaptureInput } from '../capture';
import { WeekDayAdd } from './WeekDayAdd';
import { WeekChecklistItem, WeekEventItem, WeekRoutineItem, WeekTaskItem } from './WeekItems';

/** Ce que le jour montre pendant un glisser : zone « Déposer ici » (autre jour) ou repère d'insertion (même jour, A-02). */
export type WeekDropState = { readonly kind: 'move' } | { readonly kind: 'reorder'; readonly index: number; readonly draggedId: TaskId };

export interface WeekItemDragProps {
  readonly 'data-drag-id': string;
  readonly 'data-dragging': 'true' | undefined;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Gestes de ligne de l'iPhone (A-07) ; l'appui long reste le glisser entre jours (S-02, Q16), la fiche s'ouvre par un toucher. */
export interface WeekGestures {
  readonly api: TaskGestureApi;
  readonly toggleRoutine: (id: RoutineId, date: LocalDate) => Promise<boolean>;
  readonly feedback: RowGestureFeedback;
  /** Glisser entre jours en cours : les lignes n'ont plus de geste. */
  readonly disabled: boolean;
}

export interface WeekDayViewProps {
  readonly day: WeekDay;
  readonly layout: Layout;
  /** Jour courant : PC, fond #F3F1F6 et libellés en #1F6698 ; iPhone, trait d'encre en haut de la section (UI-REFONTE-03) ; annoncé « aujourd'hui ». */
  readonly isToday: boolean;
  /** Jour courant de l'app : base du compte à rebours des événements importants (E-04) et des jours passés. */
  readonly today: LocalDate;
  /** iPhone, jour courant : heure courante, pour marquer « en retard » les tâches à l'heure dépassée (UI-REFONTE-03) ; null sinon. */
  readonly now?: LocalTime | null;
  /** iPhone : jour visé par la rangée d'ajout (UI-REFONTE-03 critère 7) ; un toucher sur la colonne de gauche le choisit. */
  readonly selected?: boolean;
  readonly onSelect?: (date: LocalDate) => void;
  readonly spaces: readonly Space[];
  readonly showSpace: boolean;
  readonly recurrences: ReadonlyMap<RecurrenceId, RecurrenceFields>;
  readonly routinesCheckable: boolean;
  /** Jour futur : cases des routines inactives (R-03 critère 11). */
  readonly routinesDisabled?: boolean;
  readonly openedTaskId: TaskId | null;
  /** Squelette de chargement (A-09) à la place des éléments. */
  readonly skeleton: boolean;
  /** Glisser (S-02) : propriétés de saisie d'une tâche ; absent : aucune carte n'est déplaçable. */
  readonly dragProps?: (id: TaskId) => WeekItemDragProps;
  /** iPhone : gestes de ligne ; absent sur PC. */
  readonly gestures?: WeekGestures | null;
  /** Glisser en cours au-dessus de ce jour. */
  readonly drop?: WeekDropState | null;
  readonly onFocusTask?: (id: TaskId) => void;
  readonly onToggleDone: (id: TaskId) => void;
  /** Ouvre la fiche de l'événement : lecture seule pour un agenda externe (S-05), modifiable pour un événement local (E-01). */
  readonly onOpenEvent?: (event: TodayEventEntry) => void;
  readonly onToggleRoutine: (id: RoutineId, date: LocalDate) => void;
  /** Ouvre l'onglet Checklists sur la checklist du jour (C-03). */
  readonly onOpenChecklist?: (id: ChecklistId) => void;
  readonly onOpen: (id: TaskId) => void;
  /** S-04, PC : ajout rapide en bas du jour ; crée la tâche de ce jour et rend true si elle l'est. Absent sur iPhone (rangée d'ajout unique). */
  readonly onAddTask?: (date: LocalDate, capture: CaptureInput) => Promise<boolean>;
}

/**
 * Un jour de la Semaine : colonne (PC) ou section (iPhone), aussi zone de dépôt du glisser (`data-drop-zone`). PC : événements en tête,
 * éléments à faire (heure puis ordre manuel), terminés, checklists ; le bas du jour reste visible quand la colonne défile (S-01 critère 9).
 * iPhone (UI-REFONTE-03, Semaine-v2.html) : même ordre que l'agenda du jour (`buildTodayAgenda`) : journée entière, à l'heure par heure
 * (événements, routines, tâches), faits à leur heure, puis sans heure ; le jour courant, une tâche à l'heure dépassée est « en retard ».
 */
export function WeekDayView(props: WeekDayViewProps) {
  const { day, layout, isToday, skeleton, drop } = props;
  const itemsRef = useRef<HTMLDivElement>(null);
  const mobile = layout === 'mobile';
  const header = mobile ? formatWeekDayLower(day.date) : formatWeekDayHeader(day.date);
  const full = formatDayFull(day.date);
  const label = isToday ? t('week.dayAriaToday', { day: full }) : full;

  // Autres tâches du jour dans l'ordre affiché : le repère d'insertion se place avant celle que vise le pointeur.
  const taskIds = [...day.list.rows, ...day.list.doneRows].filter((row) => row.kind === 'task').map((row) => row.id);
  const insertBefore = drop?.kind === 'reorder' ? (taskIds.filter((id) => id !== drop.draggedId)[drop.index] ?? null) : null;

  const gestures = mobile ? (props.gestures ?? null) : null;
  const renderRow = (row: TodayRow, late = false): ReactNode => {
    if (row.kind === 'routine') {
      const item = (
        <WeekRoutineItem
          routine={row.routine}
          time={rowTime(row)}
          done={row.done}
          layout={layout}
          spaces={props.spaces}
          showSpace={props.showSpace}
          checkable={props.routinesCheckable}
          disabled={props.routinesDisabled ?? false}
          onToggle={() => props.onToggleRoutine(row.routine.id as RoutineId, day.date)}
        />
      );
      // Routine : valider ou rouvrir pour ce jour (D3) ; jour futur ou aucune source : aucun geste.
      if (!gestures || !props.routinesCheckable || props.routinesDisabled) return <Fragment key={row.id}>{item}</Fragment>;
      const routineId = row.routine.id as RoutineId;
      const right = { label: t(row.done ? 'gestures.reopen' : 'gestures.complete'), tone: row.done ? ('reopen' as const) : ('complete' as const), onCommit: () => gestures.toggleRoutine(routineId, day.date) };
      return (
        <SwipeRow key={row.id} rowId={`${row.id}|${day.date}`} title={row.routine.title} right={right} left={[]} onLongPress={null} disabled={gestures.disabled} feedback={gestures.feedback}>
          {item}
        </SwipeRow>
      );
    }
    const id = row.task.id;
    const item = (
      <WeekTaskItem
        task={row.task}
        layout={layout}
        spaces={props.spaces}
        showSpace={props.showSpace}
        rule={row.task.recurrenceId ? props.recurrences.get(row.task.recurrenceId) : undefined}
        opened={props.openedTaskId === id}
        late={late}
        onToggleDone={() => props.onToggleDone(id)}
        onOpen={() => props.onOpen(id)}
      />
    );
    return (
      <div
        key={row.id}
        className="ct-week__itemSlot"
        data-task-id={id}
        data-insert={insertBefore === id ? 'before' : undefined}
        onFocus={() => props.onFocusTask?.(id)}
        {...props.dragProps?.(id)}
      >
        {gestures ? (
          <SwipeRow rowId={id} title={row.task.title} {...taskGestureProps(row.task, gestures.api)} onLongPress={null} disabled={gestures.disabled} feedback={gestures.feedback}>
            {item}
          </SwipeRow>
        ) : (
          item
        )}
      </div>
    );
  };

  const renderEvent = (event: TodayEventEntry): ReactNode => (
    <WeekEventItem
      key={event.id}
      event={event}
      layout={layout}
      countdown={bandCountdownTag(event, day.date, props.today)}
      {...(props.onOpenEvent && event.kind !== 'holiday' ? { onOpen: () => props.onOpenEvent?.(event) } : {})}
    />
  );

  const checklists = day.list.checklists.map((summary) => (
    <WeekChecklistItem
      key={summary.checklist.id}
      summary={summary}
      layout={layout}
      spaces={props.spaces}
      showSpace={props.showSpace}
      onOpen={() => props.onOpenChecklist?.(summary.checklist.id as ChecklistId)}
    />
  ));

  // iPhone : lignes dans l'ordre de l'agenda ; « maintenant » n'est pas dessiné dans la Semaine, les dues (« due ») sont « en retard ».
  const items = mobile ? (
    <>
      {buildTodayAgenda(day.list, isToday ? (props.now ?? null) : null).map((line) => {
        if (line.kind === 'now') return null;
        if (line.kind === 'event') return renderEvent(line.event);
        return renderRow(line.row, line.phase === 'due');
      })}
      {checklists}
      {day.list.isEmpty && <p className="ct-week-day__empty">{tWeekRefonte('dayEmpty')}</p>}
    </>
  ) : (
    <>
      {day.list.events.map(renderEvent)}
      {day.list.rows.map((row) => renderRow(row))}
      {day.list.doneRows.map((row) => renderRow(row))}
      {checklists}
    </>
  );

  const head = (
    <>
      <span className="ct-week-day__weekday" aria-hidden="true">
        {header.weekday}
      </span>
      <span className="ct-week-day__number" aria-hidden="true">
        {header.day}
      </span>
    </>
  );

  return (
    <section
      role="group"
      className="ct-week-day"
      data-layout={layout}
      data-today={isToday || undefined}
      data-past={mobile && day.date < props.today ? 'true' : undefined}
      data-weekend={mobile && weekdayOf(day.date) >= 6 ? 'true' : undefined}
      data-date={day.date}
      data-drop-zone={day.date}
      data-drop={drop?.kind}
      aria-label={label}
      {...(isToday ? { 'aria-current': 'date' as const } : {})}
    >
      {mobile ? (
        /* Un toucher sur la colonne de gauche vise ce jour pour la rangée d'ajout (UI-REFONTE-03 critère 7). */
        <button type="button" className="ct-week-day__head" aria-pressed={props.selected ?? false} aria-label={tWeekRefonte('selectDay', { day: full })} onClick={() => props.onSelect?.(day.date)}>
          {head}
        </button>
      ) : (
        <div className="ct-week-day__head">{head}</div>
      )}
      <div className="ct-week-day__body">
        <div ref={itemsRef} className="ct-week-day__items">
          {skeleton ? (
            <ListSkeleton rows={layout === 'pc' ? 2 : 1} />
          ) : (
            <>
              {items}
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
            onAdd={(capture) => props.onAddTask?.(day.date, capture) ?? Promise.resolve(false)}
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
