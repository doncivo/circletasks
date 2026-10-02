import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayList } from '../../domain/todayList';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { useSortable, type Sortable } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { todayStore } from './todayStore';

export interface TodayReorder {
  readonly sortable: Sortable;
  /** Déplace la tâche à la position `toIndex` de la liste affichée ; annonce le résultat, le focus la suit. */
  readonly applyMove: (id: string, toIndex: number) => Promise<void>;
  /** Annonce aux lecteurs d'écran (« Déplacée en position 3 sur 6 »). */
  readonly announcement: { readonly text: string; readonly n: number } | null;
}

/**
 * Réordonnancement d'Aujourd'hui (A-02) : glisser à la souris (ligne) ou au toucher (poignée du mode édition), Alt+↑ / Alt+↓ sur la
 * ligne sélectionnée. Le domaine ramène une destination interdite par l'heure (Q11).
 */
export function useTodayReorder(list: TodayList, focusedTaskId: TaskId | null): TodayReorder {
  const container = useAppContainer();
  const moveRow = useFeatureStore(todayStore, (s) => s.moveRow);
  const [announcement, setAnnouncement] = useState<TodayReorder['announcement']>(null);
  const focusAfterMove = useRef<string | null>(null);
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  });

  const applyMove = useCallback(
    async (id: string, toIndex: number): Promise<void> => {
      const outcome = await moveRow(listRef.current.rows, id, toIndex);
      if (!outcome) return;
      focusAfterMove.current = id;
      const text =
        outcome.changes.length === 0 && outcome.clamped
          ? t('today.moveUnchanged')
          : t('today.moved', { position: outcome.toIndex + 1, total: outcome.total });
      setAnnouncement((previous) => ({ text, n: (previous?.n ?? 0) + 1 }));
    },
    [moveRow],
  );

  const sortable = useSortable({
    ids: list.rows.map((row) => row.id),
    isMovable: (id) => list.rows.some((row) => row.id === id && row.kind === 'task'),
    onMove: (id, toIndex) => void applyMove(id, toIndex),
  });

  // Le focus suit la ligne déplacée (critère 3).
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    document.querySelector<HTMLElement>(`[data-sortable-id="${id}"] .ct-list-row__title`)?.focus();
  });

  useEffect(() => {
    if (!focusedTaskId) return undefined;
    const move = (delta: number) => () => {
      const index = listRef.current.rows.findIndex((row) => row.id === focusedTaskId);
      if (index >= 0) void applyMove(focusedTaskId, index + delta);
    };
    const offUp = container.shortcuts.register('list.moveUp', move(-1));
    const offDown = container.shortcuts.register('list.moveDown', move(1));
    return () => {
      offUp();
      offDown();
    };
  }, [container, focusedTaskId, applyMove]);

  return { sortable, applyMove, announcement };
}
