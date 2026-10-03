import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { DatePrompt, DragHandle, ListSkeleton } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { SomedayRow } from './SomedayRow';
import { SomedaySchedule } from './SomedaySchedule';
import type { SomedayListState } from './useSomedayListState';
import type { SomedayView } from './useSomedayView';

/**
 * Glisser vers la Semaine (S-06) : les cartes se saisissent avec `useZoneDrag` (la primitive de la Semaine, S-02) au lieu de
 * `useSortable`, pour pouvoir quitter le panneau ; une carte lâchée dans le panneau change de place.
 */
export interface SomedayZoneDnd {
  readonly itemProps: (id: string) => {
    readonly 'data-drag-id': string;
    readonly 'data-dragging': 'true' | undefined;
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /** Carte devant laquelle la carte tenue sera insérée ; null : à la fin ; undefined : rien n'est glissé au-dessus du panneau. */
  readonly insertBeforeId: string | null | undefined;
}

export interface SomedayListProps {
  /** Panneau de la Semaine : saisie par la primitive de glisser entre zones (S-06). */
  readonly zone?: SomedayZoneDnd;
  readonly view: SomedayView;
  readonly state: SomedayListState;
  /** Tâche dont la fiche est ouverte (PC) : ligne surlignée. */
  readonly openedTaskId: string | null;
  /** Squelette affiché (chargement de plus de 150 ms, A-09). */
  readonly showSkeleton: boolean;
}

/**
 * Liste des tâches « Un jour » du filtre actif (UnJour.html), dans l'ordre manuel ; état vide en une phrase. Toucher (iPhone) ou
 * cliquer (PC) une ligne la déploie avec « Aujourd'hui », « Demain » et « Choisir une date » (SD-02) : une seule ligne à la fois.
 * Au clavier PC : ↑ / ↓ sélectionnent (la ligne sélectionnée est déployée), Entrée ouvre la fiche, Espace termine, Alt+↑ / Alt+↓
 * déplacent (SD-04). Mode édition (A-05) : rond de sélection, « − » et poignée ; vue compacte (A-06) : une ligne par tâche.
 */
export function SomedayList({ view, state, openedTaskId, showSkeleton, zone }: SomedayListProps) {
  const container = useAppContainer();
  const { tasks, layout } = view;
  const { edit, reorder, compact } = state;
  const sortable = reorder.sortable;
  const [expandedId, setExpandedId] = useState<TaskId | null>(null);
  const [pickTask, setPickTask] = useState<Task | null>(null);
  // Le focus est dans la liste : seuls alors les raccourcis de ligne lui reviennent (Aujourd'hui peut être affiché à côté).
  const [focusInside, setFocusInside] = useState(false);
  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  });

  const expanded = tasks.find((task) => task.id === expandedId) ?? null;

  // ↑ / ↓ : sélectionne la ligne voisine (déployée) et lui donne le focus ; Entrée : fiche ; Espace : terminer.
  useEffect(() => {
    if (!focusInside || edit.editMode) return undefined;
    const select = (delta: number) => () => {
      const list = tasksRef.current;
      if (list.length === 0) return;
      // Point de départ : la ligne sélectionnée, sinon celle qui a le focus, sinon avant la première / après la dernière.
      const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
      const current = list.findIndex((task) => task.id === (expandedId ?? focusedId));
      const next = list[Math.min(Math.max((current < 0 ? (delta > 0 ? -1 : list.length) : current) + delta, 0), list.length - 1)];
      if (!next) return;
      setExpandedId(next.id);
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`.ct-someday__list [data-task-id="${next.id}"] .ct-list-row__title`)?.focus());
    };
    const offs = [container.shortcuts.register('list.previous', select(-1)), container.shortcuts.register('list.next', select(1))];
    if (expanded) {
      offs.push(container.shortcuts.register('list.open', () => view.openTask(expanded.id)));
      offs.push(container.shortcuts.register('list.complete', () => view.toggleDone(expanded.id)));
    }
    return () => {
      for (const off of offs) off();
    };
  }, [container, focusInside, edit.editMode, expandedId, expanded, view]);

  // Mode édition : rond de sélection et poignée, plus de dépliage ; Maj+clic / Ctrl+clic sélectionnent un intervalle.
  const clickCapture = (task: Task) =>
    edit.editMode ? { onClickCapture: (event: MouseEvent<HTMLElement>) => void edit.onRowClick(event, task.id) } : {};

  if (showSkeleton) {
    return (
      <div aria-busy="true">
        <ListSkeleton />
      </div>
    );
  }
  if (tasks.length === 0) return view.status === 'ready' ? <p className="ct-someday__empty">{view.emptyMessage}</p> : null;

  const pc = layout === 'pc';
  return (
    <>
      <div
        {...(zone ? {} : sortable.containerProps)}
        className={zone ? 'ct-someday__list' : `ct-someday__list ${sortable.containerProps.className}`}
        role="list"
        aria-label={t('someday.listLabel')}
        aria-busy={view.status === 'loading'}
        onFocus={() => setFocusInside(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusInside(false);
            state.setFocusedTaskId(null);
          }
        }}
      >
        {tasks.map((task, index) => {
          const open = !edit.editMode && task.id === expandedId;
          const handle =
            pc || edit.editMode ? (
              <DragHandle
                label={t('someday.moveHandle', { title: task.title })}
                {...(zone ? { onPointerDown: () => undefined } : sortable.dragProps(task.id, 'handle'))}
                onMoveUp={() => void reorder.applyMove(task.id, index - 1)}
                onMoveDown={() => void reorder.applyMove(task.id, index + 1)}
              />
            ) : null;
          return (
            <div
              key={task.id}
              role="listitem"
              className="ct-someday__item"
              data-task-id={task.id}
              data-expanded={open ? 'true' : undefined}
              onFocus={() => state.setFocusedTaskId(task.id)}
              {...clickCapture(task)}
              {...(zone
                ? { ...zone.itemProps(task.id), 'data-sortable-id': task.id, 'data-insert': zone.insertBeforeId === task.id ? 'before' : undefined }
                : { ...sortable.itemProps(task.id), ...sortable.dragProps(task.id, 'row') })}
            >
              <SomedayRow
                task={task}
                subtitle={view.subtitleOf(task)}
                iconSize={pc ? 24 : 28}
                compact={compact}
                editMode={edit.editMode}
                selected={edit.selection.has(task.id)}
                highlighted={!open && openedTaskId === task.id}
                handle={handle}
                handlePlacement={pc ? 'leading' : 'trailing'}
                expanded={edit.editMode ? undefined : open}
                onToggleDone={() => view.toggleDone(task.id)}
                onToggleSelect={() => edit.toggle(task.id)}
                onRemove={() => edit.setDeleteTargetId(task.id)}
                onActivate={() => setExpandedId(open ? null : task.id)}
              />
              {open && (
                <SomedaySchedule
                  task={task}
                  onPlan={(target) => void view.schedule([task.id], target)}
                  onPick={() => setPickTask(task)}
                  onOpen={() => view.openTask(task.id)}
                />
              )}
            </div>
          );
        })}
        {zone && zone.insertBeforeId === null && <div className="ct-someday__insert" aria-hidden="true" />}
      </div>
      <div key={reorder.announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {reorder.announcement?.text}
      </div>
      {pickTask && (
        <DatePrompt
          open
          label={t('someday.pickTitle')}
          confirmLabel={t('someday.pickConfirm')}
          today={view.today}
          initialValue={view.today}
          showTime
          onConfirm={(date, time) => {
            const target = pickTask;
            setPickTask(null);
            if (date !== null) void view.schedule([target.id], { date, time });
          }}
          onClose={() => setPickTask(null)}
        />
      )}
    </>
  );
}
