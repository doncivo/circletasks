import { t } from '../../i18n';
import { ListSkeleton } from '../../ui';
import { SomedayRow } from './SomedayRow';
import type { SomedayView } from './useSomedayView';

export interface SomedayListProps {
  readonly view: SomedayView;
  readonly compact: boolean;
  /** Tâche dont la fiche est ouverte (PC) : ligne surlignée. */
  readonly openedTaskId: string | null;
  /** Squelette affiché (chargement de plus de 150 ms, A-09). */
  readonly showSkeleton: boolean;
}

/** Liste des tâches « Un jour » du filtre actif (UnJour.html), dans l'ordre manuel ; état vide en une phrase. */
export function SomedayList({ view, compact, openedTaskId, showSkeleton }: SomedayListProps) {
  const { tasks, layout } = view;
  if (showSkeleton) {
    return (
      <div aria-busy="true">
        <ListSkeleton />
      </div>
    );
  }
  if (tasks.length === 0) return view.status === 'ready' ? <p className="ct-someday__empty">{view.emptyMessage}</p> : null;
  return (
    <div className="ct-someday__list" role="list" aria-label={t('someday.listLabel')} aria-busy={view.status === 'loading'}>
      {tasks.map((task) => (
        <div key={task.id} role="listitem" className="ct-someday__item" data-task-id={task.id}>
          <SomedayRow
            task={task}
            subtitle={view.subtitleOf(task)}
            iconSize={layout === 'pc' ? 24 : 28}
            compact={compact}
            editMode={false}
            selected={false}
            highlighted={openedTaskId === task.id}
            handle={null}
            onToggleDone={() => view.toggleDone(task.id)}
            onToggleSelect={() => undefined}
            onRemove={() => undefined}
            onActivate={() => view.openTask(task.id)}
          />
        </div>
      ))}
    </div>
  );
}
