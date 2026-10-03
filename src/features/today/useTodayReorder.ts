import type { TodayList } from '../../domain/todayList';
import type { TaskId } from '../../domain/types';
import { useFeatureStore } from '../app/AppContainerContext';
import { useRowReorder, type RowReorder } from '../tasks/useRowReorder';
import { todayStore } from './todayStore';

export type TodayReorder = RowReorder;

/**
 * Réordonnancement d'Aujourd'hui (A-02) : glisser à la souris (ligne) ou au toucher (poignée du mode édition), Alt+↑ / Alt+↓ sur la
 * ligne sélectionnée. Le domaine ramène une destination interdite par l'heure (Q11). Logique commune : `useRowReorder`.
 */
export function useTodayReorder(list: TodayList, focusedTaskId: TaskId | null): TodayReorder {
  const moveRow = useFeatureStore(todayStore, (s) => s.moveRow);
  return useRowReorder({ rows: list.rows, focusedTaskId, moveRow });
}
