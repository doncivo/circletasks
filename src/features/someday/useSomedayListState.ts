import { useEffect, useMemo, useState } from 'react';
import type { TodayRow } from '../../domain/todayList';
import type { TaskId } from '../../domain/types';
import { useFeatureStore } from '../app/AppContainerContext';
import { useListEditMode, type ListEditMode } from '../tasks/listEditMode';
import { useRowReorder, type RowReorder } from '../tasks/useRowReorder';
import { somedayStore } from './somedayStore';
import type { SomedayView } from './useSomedayView';

export interface SomedayListState {
  /** Tâches affichées sous la forme des lignes d'Aujourd'hui : le domaine du réordonnancement (A-02) est le même. */
  readonly rows: readonly TodayRow[];
  readonly reorder: RowReorder;
  readonly edit: ListEditMode;
  /** Vue compacte (A-06), mémorisée sous `view.compact.someday`. */
  readonly compact: boolean;
  readonly setCompact: (compact: boolean) => void;
  /** Ligne ayant le focus (Alt+↑ / Alt+↓ la déplacent) ; null quand le focus est hors de la liste. */
  readonly focusedTaskId: TaskId | null;
  readonly setFocusedTaskId: (id: TaskId | null) => void;
}

/**
 * État de la liste « Un jour » commun à l'écran iPhone et au panneau PC (SD-04) : réordonnancement (A-02, `useRowReorder`), mode
 * édition (A-05, `useListEditMode`) et vue compacte (A-06) viennent des mêmes briques qu'Aujourd'hui, sur le store de « Un jour ».
 */
export function useSomedayListState(view: SomedayView): SomedayListState {
  const compact = useFeatureStore(somedayStore, (s) => s.compact);
  const setCompact = useFeatureStore(somedayStore, (s) => s.setCompact);
  const editMode = useFeatureStore(somedayStore, (s) => s.editMode);
  const selection = useFeatureStore(somedayStore, (s) => s.selection);
  const setEditMode = useFeatureStore(somedayStore, (s) => s.setEditMode);
  const toggleSelection = useFeatureStore(somedayStore, (s) => s.toggleSelection);
  const addToSelection = useFeatureStore(somedayStore, (s) => s.addToSelection);
  const clearSelection = useFeatureStore(somedayStore, (s) => s.clearSelection);
  const moveRow = useFeatureStore(somedayStore, (s) => s.moveRow);
  const [focusedTaskId, setFocusedTaskId] = useState<TaskId | null>(null);

  const rows = useMemo<TodayRow[]>(() => view.tasks.map((task) => ({ kind: 'task', id: task.id, task })), [view.tasks]);
  const visibleTaskIds = useMemo(() => view.tasks.map((task) => task.id), [view.tasks]);
  const reorder = useRowReorder({ rows, focusedTaskId, moveRow });
  const edit = useListEditMode({ editMode, selection, setEditMode, toggleSelection, addToSelection }, visibleTaskIds);

  // Changer de filtre (espace ou projet) vide la sélection : elle ne porte que sur ce qui est affiché.
  useEffect(() => {
    clearSelection();
  }, [view.spaceFilter, view.projectFilter, clearSelection]);

  return { rows, reorder, edit, compact, setCompact: (value) => void setCompact(value), focusedTaskId, setFocusedTaskId };
}
