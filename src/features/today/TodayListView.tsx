import type { RecurrenceFields, Space } from '../../domain/model';
import { rowTime, type TodayList, type TodayRow } from '../../domain/todayList';
import type { RecurrenceId, RoutineId, SpaceFilter, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { DragHandle, ListSkeleton, SwipeRow, SwipeRowGroup, type Layout, type RowGestureFeedback } from '../../ui';
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
}

/**
 * Liste du jour (A-01) : routines et tâches mêlées, terminés en bas ; squelette pendant un chargement lent (A-09). PC : une seule
 * ligne par élément (« HH:MM · Espace » à droite) ; iPhone : sous-ligne sous le titre.
 */
export function TodayListView(props: TodayListViewProps) {
  const { list, layout, compact, spaces, spaceFilter, recurrences, edit, rowActions, reorder } = props;
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

  function renderRow(row: TodayRow, movable: boolean) {
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

  if (props.showSkeleton) {
    return (
      <div aria-busy="true">
        <ListSkeleton />
      </div>
    );
  }
  if (list.rows.length === 0 && list.doneRows.length === 0) return null;

  const clickCapture = (row: TodayRow) =>
    edit.editMode && row.kind === 'task' ? { onClickCapture: (event: React.MouseEvent<HTMLElement>) => void edit.onRowClick(event, row.task.id) } : {};

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
