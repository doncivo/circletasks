import type { ReactNode } from 'react';
import type { RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { Checkbox, IconView, ListRow, RemoveButton, SelectCircle, resolveIconRefColor } from '../../ui';
import { taskSubtitle } from '../tasks/taskLine';

/**
 * Lignes de la liste d'Aujourd'hui (A-01, A-05, A-06) : présentation seule, les actions viennent de l'écran.
 * Mode édition (Main-Edition.html) : rond de sélection à la place de la case, bouton « − », poignée ; la
 * routine n'a aucune de ces commandes (Q13).
 */

export interface TodayTaskRowProps {
  readonly task: Task;
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace est affiché. */
  readonly showSpace: boolean;
  readonly rule: RecurrenceFields | undefined;
  readonly iconSize: number;
  readonly editMode: boolean;
  readonly selected: boolean;
  /** Vue compacte (A-06) : une ligne, pastille de couleur, heure à droite. */
  readonly compact: boolean;
  readonly onToggleDone: () => void;
  readonly onOpen: () => void;
  readonly onToggleSelect: () => void;
  readonly onRemove: () => void;
  /** Poignée de déplacement (mode édition) ; absente pour une tâche terminée. */
  readonly handle: ReactNode;
}

export function TodayTaskRow({ task, spaces, showSpace, rule, iconSize, editMode, selected, compact, onToggleDone, onOpen, onToggleSelect, onRemove, handle }: TodayTaskRowProps) {
  const done = task.status === 'done';
  const color = task.icon ? resolveIconRefColor(task.icon) : undefined;
  const subtitle = editMode && done ? t('today.doneBadge') : taskSubtitle(task, { spaces, showSpace, rule });
  return (
    <ListRow
      title={task.title}
      done={done}
      selected={editMode && selected}
      compact={compact}
      {...(compact ? { time: task.time, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle })}
      leading={
        editMode ? (
          <SelectCircle selected={selected} onToggle={onToggleSelect} label={t(selected ? 'today.deselect' : 'today.select', { title: task.title })} />
        ) : (
          <Checkbox checked={done} onChange={onToggleDone} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: task.title })} />
        )
      }
      icon={!compact && !editMode && task.icon ? <IconView icon={task.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
      trailing={
        editMode ? (
          <>
            <RemoveButton label={t('today.remove', { title: task.title })} onRemove={onRemove} />
            {handle}
          </>
        ) : undefined
      }
      onActivate={onOpen}
    />
  );
}

export interface TodayRoutineRowProps {
  readonly routine: Routine;
  readonly time: LocalTime | null;
  readonly done: boolean;
  readonly iconSize: number;
  readonly compact: boolean;
  /** La routine est validable depuis la liste (une source de routines sait le faire, R-03). */
  readonly checkable: boolean;
  readonly onToggle: () => void;
}

/** Routine du jour (M4) : « HH:MM · Routine », icône à droite ; jamais sélectionnable ni déplaçable (Q13). */
export function TodayRoutineRow({ routine, time, done, iconSize, compact, checkable, onToggle }: TodayRoutineRowProps) {
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;
  return (
    <ListRow
      title={routine.title}
      done={done}
      compact={compact}
      {...(compact ? { time, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle: time ? `${time} · ${t('today.routineLabel')}` : t('today.routineLabel') })}
      {...(checkable
        ? { leading: <Checkbox checked={done} onChange={onToggle} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: routine.title })} /> }
        : {})}
      icon={!compact && routine.icon ? <IconView icon={routine.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
    />
  );
}
