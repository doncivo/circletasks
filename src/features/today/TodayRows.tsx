import type { ReactNode } from 'react';
import type { RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { formatLate } from '../../i18n/formatAgenda';
import { Checkbox, IconView, ListRow, RemoveButton, SelectCircle, resolveIconRefColor, spaceTextColor } from '../../ui';
import { routineSubtitle, TaskGoalMark, taskSubtitle } from '../tasks/taskLine';

/**
 * Lignes de la liste d'Aujourd'hui (A-01, A-05, A-06) : présentation seule, les actions viennent de l'écran.
 * Mode édition (Main-Edition.html) : rond de sélection à la place de la case, bouton « − », poignée ; la
 * routine n'a aucune de ces commandes (Q13).
 * Agenda iPhone (UI-REFONTE-02, Jour.html) : l'heure est dans la colonne de gauche (plus dans la sous-ligne), aucune icône
 * décorative, une tâche due porte « En retard de 32 min » en tête de sous-ligne, une routine sa fréquence.
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
  /** Agenda (UI-REFONTE-02) : heure hors de la sous-ligne, pas d'icône ; `lateMinutes` pour une tâche due. */
  readonly agenda?: { readonly lateMinutes: number | null };
  readonly onToggleDone: () => void;
  readonly onOpen: () => void;
  readonly onToggleSelect: () => void;
  readonly onRemove: () => void;
  /** Poignée de déplacement (mode édition) ; absente pour une tâche terminée. */
  readonly handle: ReactNode;
}

export function TodayTaskRow({ task, spaces, showSpace, rule, iconSize, editMode, selected, opened, compact, inline, agenda, onToggleDone, onOpen, onToggleSelect, onRemove, handle }: TodayTaskRowProps) {
  const done = task.status === 'done';
  const color = task.icon ? resolveIconRefColor(task.icon) : undefined;
  const base = editMode && done ? t('today.doneBadge') : taskSubtitle(task, { spaces, showSpace, rule, hideTime: agenda !== undefined });
  const late = agenda?.lateMinutes ?? null;
  const subtitle =
    late !== null && !editMode ? (
      <>
        <span className="ct-agenda__late">{formatLate(late)}</span>
        {base !== undefined && <span> · {base}</span>}
      </>
    ) : (
      base
    );
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
      icon={!compact && !editMode && !agenda && task.icon ? <IconView icon={task.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
      trailing={
        editMode ? (
          <>
            <RemoveButton label={t('today.remove', { title: task.title })} onRemove={onRemove} />
            {handle}
          </>
        ) : compact && task.goalId ? (
          <TaskGoalMark />
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
  /** Agenda (UI-REFONTE-02) : « Routine · mar., ven. », heure dans la colonne, pas d'icône. */
  readonly agenda?: boolean;
  readonly onToggle: () => void;
}

/**
 * Sous-ligne d'agenda d'une routine : « Routine », en « Tout » suivie de l'espace dans sa couleur. La fréquence de la maquette
 * (« tous les mardis et vendredis ») n'est pas écrite : son formateur et le catalogue des routines sont hors du départ (plafond du bundle).
 */
function routineAgendaSubtitle(routine: Routine, spaces: readonly Space[], showSpace: boolean): ReactNode {
  const parts: ReactNode[] = [t('today.routineLabel')];
  const space = showSpace ? spaces.find((s) => s.id === routine.spaceId) : undefined;
  if (space) parts.push(<span key="space" style={{ color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-semibold)' }}>{space.name}</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}

/** Routine du jour (M4) : « HH:MM · Routine », icône à droite ; jamais sélectionnable ni déplaçable (Q13). */
export function TodayRoutineRow({ routine, time, done, iconSize, compact, inline, spaces, showSpace, checkable, disabled = false, agenda = false, onToggle }: TodayRoutineRowProps) {
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;
  const subtitle = agenda ? routineAgendaSubtitle(routine, spaces, showSpace) : routineSubtitle(routine, time, { spaces, showSpace });
  return (
    <ListRow
      title={routine.title}
      done={done}
      compact={compact}
      inlineSubtitle={inline}
      {...(compact ? { time, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle })}
      {...(checkable
        ? { leading: <Checkbox compact={compact} checked={done} disabled={disabled} onChange={onToggle} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: routine.title })} /> }
        : {})}
      icon={!compact && !agenda && routine.icon ? <IconView icon={routine.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
    />
  );
}
