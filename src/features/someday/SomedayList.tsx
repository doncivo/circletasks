import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { DatePrompt, ListSkeleton } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { SomedayRow } from './SomedayRow';
import { SomedaySchedule } from './SomedaySchedule';
import type { SomedayView } from './useSomedayView';

export interface SomedayListProps {
  readonly view: SomedayView;
  readonly compact: boolean;
  /** Tâche dont la fiche est ouverte (PC) : ligne surlignée. */
  readonly openedTaskId: string | null;
  /** Squelette affiché (chargement de plus de 150 ms, A-09). */
  readonly showSkeleton: boolean;
}

/**
 * Liste des tâches « Un jour » du filtre actif (UnJour.html), dans l'ordre manuel ; état vide en une phrase. Toucher (iPhone) ou
 * cliquer (PC) une ligne la déploie avec « Aujourd'hui », « Demain » et « Choisir une date » (SD-02) : une seule ligne à la fois.
 * Au clavier PC : ↑ / ↓ sélectionnent (la ligne sélectionnée est déployée), Entrée ouvre la fiche, Espace termine.
 */
export function SomedayList({ view, compact, openedTaskId, showSkeleton }: SomedayListProps) {
  const container = useAppContainer();
  const { tasks, layout } = view;
  const [expandedId, setExpandedId] = useState<TaskId | null>(null);
  const [pickTask, setPickTask] = useState<Task | null>(null);
  // Le focus est dans la liste : seuls alors les raccourcis de ligne lui reviennent (Aujourd'hui peut être affiché à côté).
  const [focusInside, setFocusInside] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  });

  const expanded = tasks.find((task) => task.id === expandedId) ?? null;

  // ↑ / ↓ : sélectionne la ligne voisine (déployée) et lui donne le focus ; Entrée : fiche ; Espace : terminer.
  useEffect(() => {
    if (!focusInside) return undefined;
    const select = (delta: number) => () => {
      const list = tasksRef.current;
      if (list.length === 0) return;
      // Point de départ : la ligne sélectionnée, sinon celle qui a le focus, sinon avant la première / après la dernière.
      const focusedId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-task-id]')?.dataset['taskId'];
      const current = list.findIndex((task) => task.id === (expandedId ?? focusedId));
      const next = list[Math.min(Math.max((current < 0 ? (delta > 0 ? -1 : list.length) : current) + delta, 0), list.length - 1)];
      if (!next) return;
      setExpandedId(next.id);
      window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-task-id="${next.id}"] .ct-list-row__title`)?.focus());
    };
    const offs = [container.shortcuts.register('list.previous', select(-1)), container.shortcuts.register('list.next', select(1))];
    if (expanded) {
      offs.push(container.shortcuts.register('list.open', () => view.openTask(expanded.id)));
      offs.push(container.shortcuts.register('list.complete', () => view.toggleDone(expanded.id)));
    }
    return () => {
      for (const off of offs) off();
    };
  }, [container, focusInside, expandedId, expanded, view]);

  if (showSkeleton) {
    return (
      <div aria-busy="true">
        <ListSkeleton />
      </div>
    );
  }
  if (tasks.length === 0) return view.status === 'ready' ? <p className="ct-someday__empty">{view.emptyMessage}</p> : null;

  return (
    <>
      <div
        ref={listRef}
        className="ct-someday__list"
        role="list"
        aria-label={t('someday.listLabel')}
        aria-busy={view.status === 'loading'}
        onFocus={() => setFocusInside(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
        }}
      >
        {tasks.map((task) => {
          const open = task.id === expandedId;
          return (
            <div key={task.id} role="listitem" className="ct-someday__item" data-task-id={task.id} data-expanded={open ? 'true' : undefined}>
              <SomedayRow
                task={task}
                subtitle={view.subtitleOf(task)}
                iconSize={layout === 'pc' ? 24 : 28}
                compact={compact}
                editMode={false}
                selected={false}
                highlighted={!open && openedTaskId === task.id}
                handle={null}
                expanded={open}
                onToggleDone={() => view.toggleDone(task.id)}
                onToggleSelect={() => undefined}
                onRemove={() => undefined}
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
