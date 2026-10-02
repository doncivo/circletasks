import { CalendarDays } from 'lucide-react';
import type { RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import type { TodayEventEntry } from '../../domain/todayList';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { Checkbox, Icon, IconView, resolveIconRefColor, type Layout } from '../../ui';
import { taskSubtitle } from '../tasks/taskLine';

/**
 * Éléments d'un jour de la Semaine (S-01) : présentation seule, les actions viennent de l'écran. PC (PC-Semaine.html) : cartes
 * à case de 18 px, titre et sous-ligne (« 09:00 · Pro »). iPhone (Semaine.html) : lignes à case de 20 px, « 09:00 » puis le titre.
 */

const BOX_SIZE: Record<Layout, number> = { pc: 18, mobile: 20 };
/** PC : la souris n'a pas besoin de la zone de 44 px ; iPhone : 44 px (PRD 5). */
const HIT_SIZE: Record<Layout, number | undefined> = { pc: 24, mobile: undefined };

export interface WeekTaskItemProps {
  readonly task: Task;
  readonly layout: Layout;
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace est affiché dans la sous-ligne. */
  readonly showSpace: boolean;
  readonly rule: RecurrenceFields | undefined;
  /** Fiche détail ouverte sur cette tâche (PC) : carte surlignée. */
  readonly opened: boolean;
  readonly onToggleDone: () => void;
  readonly onOpen: () => void;
}

export function WeekTaskItem({ task, layout, spaces, showSpace, rule, opened, onToggleDone, onOpen }: WeekTaskItemProps) {
  const done = task.status === 'done';
  const checkbox = (
    <Checkbox
      checked={done}
      onChange={onToggleDone}
      label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: task.title })}
      size={BOX_SIZE[layout]}
      {...(HIT_SIZE[layout] !== undefined ? { hitSize: HIT_SIZE[layout] } : {})}
    />
  );
  const title = (
    <button type="button" className="ct-week-item__title" data-done={done} onClick={onOpen}>
      {task.title}
    </button>
  );
  if (layout === 'mobile') {
    return (
      <div className="ct-week-item" data-layout="mobile" data-done={done} data-opened={opened || undefined}>
        {checkbox}
        {task.time && <span className="ct-week-item__time">{task.time}</span>}
        {title}
      </div>
    );
  }
  const subtitle = taskSubtitle(task, { spaces, showSpace, rule });
  const color = task.icon ? resolveIconRefColor(task.icon) : undefined;
  return (
    <div className="ct-week-item" data-layout="pc" data-done={done} data-opened={opened || undefined}>
      {checkbox}
      <div className="ct-week-item__body">
        {title}
        {subtitle !== undefined && <span className="ct-week-item__sub">{subtitle}</span>}
      </div>
      {task.icon && <IconView icon={task.icon} color={color ?? 'currentColor'} size={18} />}
    </div>
  );
}

export interface WeekRoutineItemProps {
  readonly routine: Routine;
  readonly time: LocalTime | null;
  readonly done: boolean;
  readonly layout: Layout;
  /** Une source de routines sait valider (R-03) : la case est affichée. */
  readonly checkable: boolean;
  readonly onToggle: () => void;
}

/** Routine du jour (M4) : placée par son heure, jamais déplaçable (Q11) ; « 07:30 · Routine » sur PC. */
export function WeekRoutineItem({ routine, time, done, layout, checkable, onToggle }: WeekRoutineItemProps) {
  const checkbox = checkable ? (
    <Checkbox
      checked={done}
      onChange={onToggle}
      label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: routine.title })}
      size={BOX_SIZE[layout]}
      {...(HIT_SIZE[layout] !== undefined ? { hitSize: HIT_SIZE[layout] } : {})}
    />
  ) : null;
  const title = (
    <span className="ct-week-item__title" data-done={done}>
      {routine.title}
    </span>
  );
  if (layout === 'mobile') {
    return (
      <div className="ct-week-item" data-layout="mobile" data-done={done} data-kind="routine">
        {checkbox}
        {time && <span className="ct-week-item__time">{time}</span>}
        {title}
      </div>
    );
  }
  return (
    <div className="ct-week-item" data-layout="pc" data-done={done} data-kind="routine">
      {checkbox}
      <div className="ct-week-item__body">
        {title}
        <span className="ct-week-item__sub">{time ? `${time} · ${t('today.routineLabel')}` : t('today.routineLabel')}</span>
      </div>
    </div>
  );
}

export interface WeekEventItemProps {
  readonly event: TodayEventEntry;
  readonly layout: Layout;
}

/**
 * Événement du jour, lecture seule : sans case ni poignée. Externe (agenda lu par M8) : fond #E3EEF5 et nom de l'agenda ;
 * interne (M7) : style distinct (anniversaire, #FBE7E4).
 */
export function WeekEventItem({ event, layout }: WeekEventItemProps) {
  const external = event.calendarName !== null;
  const when = event.allDay ? null : event.startTime;
  const icon = event.icon ? (
    <IconView icon={event.icon} size={18} color="currentColor" />
  ) : (
    <Icon icon={CalendarDays} size={18} />
  );
  if (layout === 'mobile') {
    return (
      <div className="ct-week-event" data-layout="mobile" data-source={external ? 'external' : 'local'}>
        {icon}
        {when && <span className="ct-week-item__time">{when}</span>}
        <span className="ct-week-item__title">{event.title}</span>
      </div>
    );
  }
  return (
    <div className="ct-week-event" data-layout="pc" data-source={external ? 'external' : 'local'}>
      <span className="ct-week-item__title">{when ? `${when} ${event.title}` : event.title}</span>
      {event.calendarName && <span className="ct-week-event__source">{event.calendarName}</span>}
    </div>
  );
}
