import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { addDays } from '../../domain/localDate';
import type { Space } from '../../domain/model';
import { rowIndexForDrop, type WeekDay } from '../../domain/week';
import type { LocalDate, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { ChoiceDialog, DragGhost, useZoneDrag } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import type { ItemFilter } from '../../domain/itemFilter';
import { selectSomedayTasks } from '../../domain/someday';
import type { TodayRow } from '../../domain/todayList';
import { useAppStore } from '../app/appStore';
import { somedayStore, useItemFilter, type SomedayZoneDnd } from '../someday';
import { taskSubtitle } from '../tasks/taskLine';
import type { WeekDropState, WeekItemDragProps } from './WeekDayView';
import { weekStore } from './weekStore';

/** Choix « cette occurrence / toutes les suivantes » en attente pour une tâche récurrente (T-10). */
type ScopeRequest = { readonly kind: 'postpone'; readonly id: TaskId };

export interface WeekMoves {
  /** Propriétés de saisie d'une carte (souris, appui long tactile). */
  readonly dragProps: (id: TaskId) => WeekItemDragProps;
  /** Ce que le jour montre pendant le glisser. */
  readonly dropFor: (date: LocalDate) => WeekDropState | null;
  readonly dragging: boolean;
  /** Carte volante à rendre pendant le glisser. */
  readonly ghost: ReactNode;
  /** Question de portée d'une tâche récurrente. */
  readonly dialogs: ReactNode;
  /** Tâche « sélectionnée » au clavier : la dernière à avoir reçu le focus. */
  readonly setFocusedTaskId: (id: TaskId) => void;
  /** Annonce aux lecteurs d'écran (réordonnancement au clavier ou au glisser). */
  readonly announcement: { readonly text: string; readonly n: number } | null;
  /** Panneau « Un jour » (S-06) : ses cartes se saisissent avec la même primitive que les cartes des jours (`useZoneDrag`). */
  readonly somedayZone: SomedayZoneDnd;
}

/** Zone de dépôt du panneau « Un jour » (`data-drop-zone`) : réordonne ses cartes ; les autres zones sont des dates ISO. */
export const SOMEDAY_ZONE = 'someday';

/**
 * Déplacements de tâches dans la Semaine (S-02) : glisser à la souris ou au toucher (appui long) d'un jour à l'autre, ou dans le
 * même jour (réordonne, A-02 / Q11) ; au clavier, sur la carte sélectionnée : Alt+← / Alt+→ (jour précédent / suivant de la
 * semaine), Ctrl+D (demain, T-05), Alt+↑ / Alt+↓ (ordre du jour). Seul Ctrl+D (report) d'une occurrence récurrente pose la question de
 * portée (T-10) ; glisser ou Alt+←/→ ne déplace que cette occurrence, sans question (S-02 critère 8). Routines et événements ne sont jamais saisis.
 */
export function useWeekMoves(days: readonly WeekDay[], weekStart: LocalDate, spaces: readonly Space[], showSpace: boolean, somedayOpen = false): WeekMoves {
  const container = useAppContainer();
  const moveToDay = useFeatureStore(weekStore, (s) => s.moveToDay);
  const postpone = useFeatureStore(weekStore, (s) => s.postpone);
  const postponeSeries = useFeatureStore(weekStore, (s) => s.postponeSeries);
  const moveRow = useFeatureStore(weekStore, (s) => s.moveRow);
  const scheduleSomeday = useFeatureStore(somedayStore, (s) => s.schedule);
  const moveSomedayRow = useFeatureStore(somedayStore, (s) => s.moveRow);
  const projects = useAppStore((s) => s.projects);
  const itemFilter = useItemFilter();
  const itemFilterRef = useRef(itemFilter);
  useEffect(() => {
    itemFilterRef.current = itemFilter;
  });
  const [focusedTaskId, setFocusedTaskId] = useState<TaskId | null>(null);
  const [scope, setScope] = useState<ScopeRequest | null>(null);
  const [announcement, setAnnouncement] = useState<WeekMoves['announcement']>(null);
  const focusAfterMove = useRef<TaskId | null>(null);
  const daysRef = useRef(days);
  useEffect(() => {
    daysRef.current = days;
  });

  const requestMove = useCallback(
    (id: TaskId, date: LocalDate): void => {
      const task = container.taskEntities.get(id);
      if (!task || task.date === date) return;
      // Déplacer une occurrence ne concerne qu'elle (S-02 critère 8) : aucune question, la série garde son ancre.
      void moveToDay(id, date);
    },
    [container, moveToDay],
  );

  const requestPostpone = useCallback(
    (id: TaskId): void => {
      const task = container.taskEntities.get(id);
      if (!task || task.status === 'done') return;
      if (task.recurrenceId !== null) setScope({ kind: 'postpone', id });
      else void postpone(id, 'tomorrow');
    },
    [container, postpone],
  );

  /** Réordonne dans le jour de la tâche : le domaine ramène une destination interdite par l'heure (Q11). */
  const reorder = useCallback(
    async (id: TaskId, date: LocalDate, toIndex: (day: WeekDay) => number): Promise<void> => {
      const day = daysRef.current.find((candidate) => candidate.date === date);
      if (!day) return;
      const outcome = await moveRow(day.list.rows, id, toIndex(day));
      if (!outcome) return;
      focusAfterMove.current = id;
      const text = outcome.changes.length === 0 && outcome.clamped ? t('today.moveUnchanged') : t('today.moved', { position: outcome.toIndex + 1, total: outcome.total });
      setAnnouncement((previous) => ({ text, n: (previous?.n ?? 0) + 1 }));
    },
    [moveRow],
  );

  /** Cartes du panneau « Un jour » dans l'ordre affiché (filtre global), sous la forme des lignes d'Aujourd'hui (A-02). */
  const somedayRowsOf = (filter: ItemFilter): TodayRow[] =>
    selectSomedayTasks(container.taskEntities.getSnapshot().values(), filter).map((task) => ({ kind: 'task', id: task.id, task }));

  const zoneDrag = useZoneDrag({
    isMovable: (id) => container.taskEntities.get(id as TaskId) !== undefined,
    onDrop: (id, zone, index) => {
      const task = container.taskEntities.get(id as TaskId);
      if (!task) return;
      if (task.someday) {
        // S-06 : une carte du panneau « Un jour » lâchée sur un jour est planifiée à cette date (sans heure) ; lâchée dans le
        // panneau, elle change de place (SD-04). Annulable : elle retrouve sa position dans le panneau.
        if (zone === SOMEDAY_ZONE) void moveSomedayRow(somedayRowsOf(itemFilterRef.current), task.id, index);
        else void scheduleSomeday([task.id], { date: zone as LocalDate });
        return;
      }
      // Une carte datée lâchée sur le panneau « Un jour » ne fait rien (le renvoi passe par la fiche, SD-03).
      if (zone === SOMEDAY_ZONE) return;
      const date = zone as LocalDate;
      if (task.date === date) void reorder(task.id, date, (day) => rowIndexForDrop(day.list, id, index));
      else requestMove(task.id, date);
    },
  });

  // Le focus suit la carte réordonnée (comme Aujourd'hui, A-02).
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    document.querySelector<HTMLElement>(`[data-task-id="${id}"] .ct-week-item__title`)?.focus();
  });

  // Clavier, sur la carte sélectionnée (registre de raccourcis, ADR 0004).
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    const lastDay = addDays(weekStart, 6);
    const shift = (delta: number) => (): void => {
      const task = container.taskEntities.get(focusedTaskId);
      if (!task || task.date === null) return;
      const target = addDays(task.date, delta);
      // Une semaine à la fois : aucun glisser vers une autre semaine (S-02, hors périmètre).
      if (target >= weekStart && target <= lastDay) requestMove(focusedTaskId, target);
    };
    const reorderBy = (delta: number) => (): void => {
      const task = container.taskEntities.get(focusedTaskId);
      if (!task || task.date === null) return;
      const date = task.date;
      void reorder(focusedTaskId, date, (day) => day.list.rows.findIndex((row) => row.id === focusedTaskId) + delta);
    };
    const offs = [
      container.shortcuts.register('week.moveEarlier', shift(-1)),
      container.shortcuts.register('week.moveLater', shift(1)),
      container.shortcuts.register('list.postponeTomorrow', () => requestPostpone(focusedTaskId)),
      container.shortcuts.register('list.moveUp', reorderBy(-1)),
      container.shortcuts.register('list.moveDown', reorderBy(1)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [container, focusedTaskId, weekStart, requestMove, requestPostpone, reorder]);

  const { drag } = zoneDrag;
  const dragged = drag ? container.taskEntities.get(drag.id as TaskId) : undefined;
  const dropFor = (date: LocalDate): WeekDropState | null => {
    if (!drag || drag.zone !== date || !dragged) return null;
    if (dragged.someday) return { kind: 'move' }; // S-06 : planifier depuis « Un jour »
    if (dragged.date !== date) return { kind: 'move' };
    // Même jour : seule une tâche à faire se réordonne (A-02).
    return dragged.status === 'todo' ? { kind: 'reorder', index: drag.index ?? 0, draggedId: dragged.id } : null;
  };

  // Repère d'insertion du panneau : carte devant laquelle la carte tenue se placera ; null = à la fin ; undefined = aucun glisser dessus.
  let somedayInsert: string | null | undefined;
  if (somedayOpen && drag?.zone === SOMEDAY_ZONE && dragged?.someday) {
    const others = somedayRowsOf(itemFilter).filter((row) => row.id !== dragged.id);
    somedayInsert = others[drag.index ?? 0]?.id ?? null;
  }

  const scopeTask = scope ? container.taskEntities.get(scope.id) : undefined;
  const dialogs = scope && scopeTask && (
    <ChoiceDialog
      title={t('tasks.seriesPostponeTitle', { title: scopeTask.title })}
      description={t('tasks.seriesPostponeBody')}
      options={[
        { id: 'occurrence', label: t('tasks.seriesScopeOccurrence') },
        { id: 'following', label: t('tasks.seriesScopeFollowing') },
      ]}
      onChoose={(choice) => {
        setScope(null);
        void postponeSeries(scope.id, 'tomorrow', choice);
      }}
      onCancel={() => setScope(null)}
    />
  );

  return {
    dragProps: (id) => zoneDrag.itemProps(id),
    dropFor,
    dragging: drag !== null,
    ghost: dragged && (
      <DragGhost
        ghostRef={zoneDrag.attachGhost}
        title={dragged.title}
        subtitle={taskSubtitle(dragged, { spaces, showSpace: showSpace || dragged.someday, rule: undefined, ...(dragged.someday ? { projects } : {}) })}
      />
    ),
    dialogs,
    setFocusedTaskId,
    announcement,
    somedayZone: {
      itemProps: (id) => zoneDrag.itemProps(id),
      insertBeforeId: somedayInsert,
    },
  };
}
