import type { RecurrenceFields, Space } from '../../domain/model';
import { rowTime, type TodayList, type TodayRow } from '../../domain/todayList';
import type { RecurrenceId, RoutineId, SpaceFilter, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { DragHandle, ListSkeleton, type Layout } from '../../ui';
import { TodayRoutineRow, TodayTaskRow } from './TodayRows';
import type { TodayRowActions } from './TodayRowActions';
import type { TodayReorder } from './useTodayReorder';
import type { TodayEditMode } from './useTodayEditMode';

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
  /** Tâche dont la fiche est ouverte (PC) : ligne surlignée. */
  readonly openedTaskId: TaskId | null;
  readonly edit: TodayEditMode;
  readonly rowActions: TodayRowActions;
  readonly reorder: TodayReorder;
  readonly onToggleDone: (id: TaskId) => void;
  readonly onToggleRoutine: (id: RoutineId) => void;
  readonly onOpen: (id: TaskId) => void;
}

/**
 * Liste du jour (A-01) : routines et tâches mêlées, terminés en bas ; squelette pendant un chargement lent (A-09). PC : une seule
 * ligne par élément (« HH:MM · Espace » à droite) ; iPhone : sous-ligne sous le titre.
 */
export function TodayListView(props: TodayListViewProps) {
  const { list, layout, compact, spaces, spaceFilter, recurrences, edit, rowActions, reorder } = props;
  const iconSize = layout === 'pc' ? 24 : 28;
  const inline = layout === 'pc';

  function renderRow(row: TodayRow, movable: boolean) {
    if (row.kind === 'routine') {
      return (
        <TodayRoutineRow
          routine={row.routine}
          time={rowTime(row)}
          done={row.done}
          iconSize={iconSize}
          compact={compact}
          inline={inline}
          checkable={props.routinesCheckable}
          onToggle={() => props.onToggleRoutine(row.routine.id as RoutineId)}
        />
      );
    }
    const task = row.task;
    const index = list.rows.findIndex((candidate) => candidate.id === row.id);
    return (
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
  if (list.rows.length === 0 && list.doneRows.length === 0) return null;

  const clickCapture = (row: TodayRow) =>
    edit.editMode && row.kind === 'task' ? { onClickCapture: (event: React.MouseEvent<HTMLElement>) => void edit.onRowClick(event, row.task.id) } : {};

  return (
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
          onFocus={() => row.kind === 'task' && rowActions.setFocusedTaskId(row.task.id)}
          {...clickCapture(row)}
          {...reorder.sortable.itemProps(row.id)}
          {...(row.kind === 'task' ? reorder.sortable.dragProps(row.id, 'row') : {})}
        >
          {renderRow(row, row.kind === 'task')}
        </div>
      ))}
      {list.doneRows.map((row) => (
        <div key={row.id} role="listitem" onFocus={() => row.kind === 'task' && rowActions.setFocusedTaskId(row.task.id)} {...clickCapture(row)}>
          {renderRow(row, false)}
        </div>
      ))}
    </div>
  );
}
