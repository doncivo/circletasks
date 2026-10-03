import type { ReactNode } from 'react';
import type { RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { Checkbox, IconView, ListRow, RemoveButton, SelectCircle, resolveIconRefColor } from '../../ui';
import { routineSubtitle, taskSubtitle } from '../tasks/taskLine';

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
  /** Fiche détail ouverte sur cette tâche (PC) : ligne surlignée (A-08 critère 1). */
  readonly opened: boolean;
  /** Vue compacte (A-06) : une ligne, pastille de couleur, heure à droite. */
  readonly compact: boolean;
  /** PC : « HH:MM · Espace » à droite du titre, sur une seule ligne. */
  readonly inline: boolean;
  readonly onToggleDone: () => void;
  readonly onOpen: () => void;
  readonly onToggleSelect: () => void;
  readonly onRemove: () => void;
  /** Poignée de déplacement (mode édition) ; absente pour une tâche terminée. */
  readonly handle: ReactNode;
}

export function TodayTaskRow({ task, spaces, showSpace, rule, iconSize, editMode, selected, opened, compact, inline, onToggleDone, onOpen, onToggleSelect, onRemove, handle }: TodayTaskRowProps) {
  const done = task.status === 'done';
  const color = task.icon ? resolveIconRefColor(task.icon) : undefined;
  const subtitle = editMode && done ? t('today.doneBadge') : taskSubtitle(task, { spaces, showSpace, rule });
  return (
    <ListRow
      title={task.title}
      done={done}
      selected={(editMode && selected) || opened}
      compact={compact}
      inlineSubtitle={inline}
      {...(compact ? { time: task.time, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle })}
      leading={
        editMode ? (
          <SelectCircle selected={selected} onToggle={onToggleSelect} label={t(selected ? 'today.deselect' : 'today.select', { title: task.title })} />
        ) : (
          <Checkbox compact={compact} checked={done} onChange={onToggleDone} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: task.title })} />
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
  readonly inline: boolean;
  /** Espaces et filtre « Tout » : l'espace est écrit après « Routine » (ES-03). */
  readonly spaces: readonly Space[];
  readonly showSpace: boolean;
  /** La routine est validable depuis la liste (une source de routines sait le faire, R-03). */
  readonly checkable: boolean;
  /** Jour futur : seuls aujourd'hui et les jours passés se valident (R-03 critère 11, QB-03) ; la case est inactive. */
  readonly disabled?: boolean;
  readonly onToggle: () => void;
}

/** Routine du jour (M4) : « HH:MM · Routine », icône à droite ; jamais sélectionnable ni déplaçable (Q13). */
export function TodayRoutineRow({ routine, time, done, iconSize, compact, inline, spaces, showSpace, checkable, disabled = false, onToggle }: TodayRoutineRowProps) {
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;
  return (
    <ListRow
      title={routine.title}
      done={done}
      compact={compact}
      inlineSubtitle={inline}
      {...(compact ? { time, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle: routineSubtitle(routine, time, { spaces, showSpace }) })}
      {...(checkable
        ? { leading: <Checkbox compact={compact} checked={done} disabled={disabled} onChange={onToggle} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: routine.title })} /> }
        : {})}
      icon={!compact && routine.icon ? <IconView icon={routine.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
    />
  );
}
