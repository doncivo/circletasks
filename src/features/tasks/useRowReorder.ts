import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayRow } from '../../domain/todayList';
import type { MoveOutcome } from '../../domain/taskReorder';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { useSortable, type Sortable } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';

export interface RowReorder {
  readonly sortable: Sortable;
  /** Déplace la tâche à la position `toIndex` de la liste affichée ; annonce le résultat, le focus la suit. */
  readonly applyMove: (id: string, toIndex: number) => Promise<void>;
  /** Annonce aux lecteurs d'écran (« Déplacée en position 3 sur 6 »). */
  readonly announcement: { readonly text: string; readonly n: number } | null;
}

export interface RowReorderOptions {
  /** Éléments à faire affichés, dans l'ordre (routines comprises pour Aujourd'hui). */
  readonly rows: readonly TodayRow[];
  /** Ligne « sélectionnée » au clavier : Alt+↑ / Alt+↓ la déplacent. */
  readonly focusedTaskId: TaskId | null;
  /** Écrit le nouvel ordre (annulable) ; null : élément non déplaçable ou échec. */
  readonly moveRow: (rows: readonly TodayRow[], id: string, toIndex: number) => Promise<MoveOutcome | null>;
}

/**
 * Réordonnancement d'une liste de tâches (A-02, SD-04) : glisser à la souris (ligne) ou au toucher (poignée du mode édition), Alt+↑ /
 * Alt+↓ sur la ligne sélectionnée. Commun à Aujourd'hui (le domaine ramène une destination interdite par l'heure, Q11) et à « Un
 * jour » (aucune heure : toute position est permise).
 */
export function useRowReorder({ rows, focusedTaskId, moveRow }: RowReorderOptions): RowReorder {
  const container = useAppContainer();
  const [announcement, setAnnouncement] = useState<RowReorder['announcement']>(null);
  const focusAfterMove = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });

  const applyMove = useCallback(
    async (id: string, toIndex: number): Promise<void> => {
      const outcome = await moveRow(rowsRef.current, id, toIndex);
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
    ids: rows.map((row) => row.id),
    isMovable: (id) => rows.some((row) => row.id === id && row.kind === 'task'),
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
      const index = rowsRef.current.findIndex((row) => row.id === focusedTaskId);
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
