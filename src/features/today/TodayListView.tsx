import type { RecurrenceFields, Space } from '../../domain/model';
import type { AgendaLine } from '../../domain/todayAgenda';
import { rowTime, type TodayEventEntry, type TodayList, type TodayRow } from '../../domain/todayList';
import type { EventId, LocalDate, RecurrenceId, RoutineId, SpaceFilter, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { formatNowLabel } from '../../i18n/formatAgenda';
import { DragHandle, ListRow, ListSkeleton, SwipeRow, SwipeRowGroup, type Layout, type RowGestureFeedback } from '../../ui';
import { bandCountdownTag } from '../events/bandCountdown';
import { taskGestureProps, type TaskGestureApi } from '../tasks/taskGestures';
import { TodayRoutineRow, TodayTaskRow } from './TodayRows';
import type { TodayRowActions } from './TodayRowActions';
import type { TodayReorder } from './useTodayReorder';
import type { TodayEditMode } from './useTodayEditMode';

/** Gestes de ligne de l'iPhone (A-07) ; absents sur PC (les lignes ne sont alors pas enveloppées). */
export interface TodayGestures {
  readonly api: TaskGestureApi;
  /** Valide ou rouvre une routine pour la date affichée (R-03) ; vrai si abouti. */
  readonly toggleRoutine: (id: RoutineId) => Promise<boolean>;
  readonly feedback: RowGestureFeedback;
}

/** Agenda du jour (UI-REFONTE-02, iPhone) : lignes placées sur la colonne des heures, événements compris. */
export interface TodayAgendaView {
  readonly lines: readonly AgendaLine[];
  readonly date: LocalDate;
  readonly today: LocalDate;
  /** Ouvre un événement local en modification (E-01 critère 7) ; un événement d'agenda externe reste en lecture seule. */
  readonly onOpenEvent: (id: EventId) => void;
}

export interface TodayListViewProps {
  readonly list: TodayList;
  readonly layout: Layout;
  readonly compact: boolean;
  readonly loading: boolean;
  /** Squelette affiché (chargement de plus de 150 ms, A-09). */
  readonly showSkeleton: boolean;
  readonly spaces: readonly Space[];
  readonly spaceFilter: SpaceFilter;
  readonly recurrences: ReadonlyMap<RecurrenceId, RecurrenceFields>;
  readonly routinesCheckable: boolean;
  /** Jour futur affiché (flèches PC) : cases des routines inactives (R-03 critère 11). */
  readonly routinesDisabled: boolean;
  /** Tâche dont la fiche est ouverte (PC) : ligne surlignée. */
  readonly openedTaskId: TaskId | null;
  readonly edit: TodayEditMode;
  readonly rowActions: TodayRowActions;
  readonly reorder: TodayReorder;
  readonly onToggleDone: (id: TaskId) => void;
  readonly onToggleRoutine: (id: RoutineId) => void;
  readonly onOpen: (id: TaskId) => void;
  readonly gestures: TodayGestures | null;
  /** iPhone : agenda du jour (Jour.html) ; absent sur PC (liste mêlée, terminés en bas). */
  readonly agenda?: TodayAgendaView | null;
}

/**
 * Liste du jour (A-01). PC : routines et tâches mêlées, terminés en bas, une seule ligne par élément (« HH:MM · Espace » à droite).
 * iPhone (UI-REFONTE-02) : agenda sur la colonne des heures, ligne « maintenant », passé atténué, dû en gros, sans heure derrière un tiret.
 * Squelette pendant un chargement lent (A-09).
 */
export function TodayListView(props: TodayListViewProps) {
  const { list, layout, compact, spaces, spaceFilter, recurrences, edit, rowActions, reorder, agenda } = props;
  const iconSize = layout === 'pc' ? 24 : 28;
  const inline = layout === 'pc';

  /** Ligne « sélectionnée » au clavier : Espace la termine (tâche) ou la valide (routine, R-03 critère 8). */
  function focusRow(row: TodayRow): void {
    if (row.kind === 'task') rowActions.setFocusedTaskId(row.task.id);
    else rowActions.setFocusedRoutineId(row.routine.id as RoutineId);
  }

  /** iPhone : la ligne est enveloppée dans un `SwipeRow` ; mode édition ou glisser en cours : aucun geste. */
  function swiped(row: TodayRow, content: JSX.Element): JSX.Element {
    const gestures = props.gestures;
    if (!gestures) return content;
    const disabled = edit.editMode || reorder.sortable.drag !== null;
    if (row.kind === 'routine') {
      // Routine : valider ou rouvrir seulement (D3) ; jour futur ou aucune source : aucun geste.
      if (!props.routinesCheckable || props.routinesDisabled) return content;
      const id = row.routine.id as RoutineId;
      const right = { label: t(row.done ? 'gestures.reopen' : 'gestures.complete'), tone: row.done ? ('reopen' as const) : ('complete' as const), onCommit: () => gestures.toggleRoutine(id) };
      return (
        <SwipeRow rowId={row.id} title={row.routine.title} right={right} left={[]} onLongPress={null} disabled={disabled} feedback={gestures.feedback}>
          {content}
        </SwipeRow>
      );
    }
    const task = row.task;
    const { right, left } = taskGestureProps(task, gestures.api);
    return (
      <SwipeRow rowId={row.id} title={task.title} right={right} left={left} onLongPress={() => props.onOpen(task.id)} disabled={disabled} feedback={gestures.feedback}>
        {content}
      </SwipeRow>
    );
  }

  function renderRow(row: TodayRow, movable: boolean, lateMinutes: number | null = null, hour: React.ReactNode = null) {
    const inAgenda = agenda != null;
    if (row.kind === 'routine') {
      return swiped(
        row,
        <TodayRoutineRow
          routine={row.routine}
          time={rowTime(row)}
          done={row.done}
          iconSize={iconSize}
          compact={compact}
          inline={inline}
          spaces={spaces}
          showSpace={spaceFilter === 'all'}
          checkable={props.routinesCheckable}
          disabled={props.routinesDisabled}
          agenda={inAgenda ? { hour } : null}
          onToggle={() => props.onToggleRoutine(row.routine.id as RoutineId)}
        />,
      );
    }
    const task = row.task;
    const index = list.rows.findIndex((candidate) => candidate.id === row.id);
    return swiped(
      row,
      <TodayTaskRow
        task={task}
        spaces={spaces}
        showSpace={spaceFilter === 'all'}
        rule={task.recurrenceId ? recurrences.get(task.recurrenceId) : undefined}
        iconSize={iconSize}
        editMode={edit.editMode}
        selected={edit.selection.has(task.id)}
        opened={props.openedTaskId === task.id}
        compact={compact}
        inline={inline}
        {...(inAgenda ? { agenda: { lateMinutes, hour } } : {})}
        onToggleDone={() => props.onToggleDone(task.id)}
        onOpen={() => props.onOpen(task.id)}
        onToggleSelect={() => edit.toggle(task.id)}
        onRemove={() => edit.setDeleteTargetId(task.id)}
        handle={
          movable ? (
            <DragHandle
              label={t('today.moveHandle', { title: task.title })}
              {...reorder.sortable.dragProps(row.id, 'handle')}
              onMoveUp={() => void reorder.applyMove(row.id, index - 1)}
              onMoveDown={() => void reorder.applyMove(row.id, index + 1)}
            />
          ) : null
        }
      />,
    );
  }

  /** Événement dans l'agenda (E-01 à E-04, M8) : rond au trait, titre, source ou « Toute la journée », compte à rebours (E-04). */
  function renderEvent(event: TodayEventEntry, view: TodayAgendaView, hour: React.ReactNode) {
    const countdown = bandCountdownTag(event, view.date, view.today);
    const source = event.calendarName ?? (event.allDay || event.startTime === null ? t('today.eventAllDay') : null);
    const subtitle =
      source || countdown ? (
        <>
          {source}
          {source && countdown && ' · '}
          {countdown && (
            <span className="ct-agenda__countdown" data-tag={countdown.kind}>
              <span aria-hidden={countdown.spoken ? 'true' : undefined}>{countdown.label}</span>
              {countdown.spoken && <span className="ct-visually-hidden">{countdown.spoken}</span>}
            </span>
          )}
        </>
      ) : undefined;
    const interactive = event.calendarName === null && event.kind !== 'holiday';
    return (
      <ListRow
        title={event.title}
        className="ct-agenda__eventRow"
        prefix={hour}
        leading={<span className="ct-agenda__eventMark" data-kind={event.kind} aria-hidden="true" />}
        {...(subtitle !== undefined ? { subtitle } : {})}
        {...(interactive ? { onActivate: () => view.onOpenEvent(event.id as EventId) } : {})}
      />
    );
  }

  if (props.showSkeleton) {
    return (
      <div aria-busy="true">
        <ListSkeleton />
      </div>
    );
  }

  const clickCapture = (row: TodayRow) =>
    edit.editMode && row.kind === 'task' ? { onClickCapture: (event: React.MouseEvent<HTMLElement>) => void edit.onRowClick(event, row.task.id) } : {};

  if (agenda) {
    if (agenda.lines.length === 0) return null;
    return (
      <SwipeRowGroup>
        <div
          {...reorder.sortable.containerProps}
          className={`ct-today__list ct-today__list--agenda ${reorder.sortable.containerProps.className}`}
          aria-label={t('today.listLabel')}
          aria-busy={props.loading}
          role="list"
        >
          {agenda.lines.map((line) => {
            if (line.kind === 'now') {
              return (
                <div key="now" role="listitem" className="ct-agenda__now" aria-label={formatNowLabel(line.time)}>
                  <span className="ct-agenda__hour ct-agenda__hour--now">{formatTime(line.time)}</span>
                  <span className="ct-agenda__nowDot" aria-hidden="true" />
                  <span className="ct-agenda__nowBar" aria-hidden="true" />
                </div>
              );
            }
            const hour = line.time === null ? <span className="ct-agenda__hour ct-agenda__hour--none" aria-label={t('today.untimed')}>—</span> : <span className="ct-agenda__hour">{formatTime(line.time)}</span>;
            if (line.kind === 'event') {
              return (
                <div key={line.id} role="listitem" className="ct-agenda__line" data-phase={line.phase}>
                  {renderEvent(line.event, agenda, hour)}
                </div>
              );
            }
            const row = line.row;
            const movable = row.kind === 'task' && list.rows.some((candidate) => candidate.id === row.id);
            return (
              <div
                key={row.id}
                role="listitem"
                className="ct-agenda__line"
                data-phase={line.phase}
                onFocus={() => focusRow(row)}
                {...clickCapture(row)}
                {...(movable ? reorder.sortable.itemProps(row.id) : {})}
                {...(movable ? reorder.sortable.dragProps(row.id, 'row') : {})}
              >
                {renderRow(row, movable, line.lateMinutes, hour)}
              </div>
            );
          })}
        </div>
      </SwipeRowGroup>
    );
  }

  if (list.rows.length === 0 && list.doneRows.length === 0) return null;

  return (
    <SwipeRowGroup>
    <div
      {...reorder.sortable.containerProps}
      className={`ct-today__list ${reorder.sortable.containerProps.className}`}
      aria-label={t('today.listLabel')}
      aria-busy={props.loading}
      role="list"
    >
      {list.rows.map((row) => (
        <div
          key={row.id}
          role="listitem"
          onFocus={() => focusRow(row)}
          {...clickCapture(row)}
          {...reorder.sortable.itemProps(row.id)}
          {...(row.kind === 'task' ? reorder.sortable.dragProps(row.id, 'row') : {})}
        >
          {renderRow(row, row.kind === 'task')}
        </div>
      ))}
      {list.doneRows.map((row) => (
        <div key={row.id} role="listitem" onFocus={() => focusRow(row)} {...clickCapture(row)}>
          {renderRow(row, false)}
        </div>
      ))}
    </div>
    </SwipeRowGroup>
  );
}
