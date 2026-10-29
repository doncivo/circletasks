import type { ChecklistSummary, RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import type { TodayEventEntry } from '../../domain/todayList';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { tWeekRefonte } from '../../i18n/weekRefonteText';
import { Checkbox, IconView, resolveIconRefColor, spaceTextColor, type Layout } from '../../ui';
import { ChecklistIcon } from '../checklists/ChecklistIcon';
import type { CountdownTag } from '../events/countdownText';
import { routineSubtitle, TaskGoalMark, taskSubtitle } from '../tasks/taskLine';

/**
 * Éléments d'un jour de la Semaine (S-01) : présentation seule, les actions viennent de l'écran. PC (PC-Semaine.html) : cartes
 * à case de 18 px, titre et sous-ligne (« 09:00 · Pro »). iPhone (UI-REFONTE-03, Semaine-v2.html) : lignes alignées sur l'agenda du
 * jour : colonne d'heures (« 09:00 » ou tiret), case de 20 px, titre ; faits barrés à leur heure ; « en retard » le jour courant.
 */

const BOX_SIZE: Record<Layout, number> = { pc: 18, mobile: 20 };
/** PC : la souris n'a pas besoin de la zone de 44 px ; iPhone : 44 px (PRD 5). */
const HIT_SIZE: Record<Layout, number | undefined> = { pc: 24, mobile: undefined };

/** Colonne d'heures de la ligne iPhone : heure en chiffres tabulaires, ou tiret décoratif sans heure (annoncé par rien : le titre suffit). */
function HourCell({ time }: { readonly time: LocalTime | null }) {
  return time ? (
    <span className="ct-week-item__time">{formatTime(time)}</span>
  ) : (
    <span className="ct-week-item__time" data-none="true" aria-hidden="true">
      —
    </span>
  );
}

export interface WeekTaskItemProps {
  readonly task: Task;
  readonly layout: Layout;
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace est affiché dans la sous-ligne. */
  readonly showSpace: boolean;
  readonly rule: RecurrenceFields | undefined;
  /** Fiche détail ouverte sur cette tâche (PC) : carte surlignée. */
  readonly opened: boolean;
  /** iPhone, jour courant : tâche non faite dont l'heure est dépassée (UI-REFONTE-03 critère 5). */
  readonly late?: boolean;
  readonly onToggleDone: () => void;
  readonly onOpen: () => void;
}

export function WeekTaskItem({ task, layout, spaces, showSpace, rule, opened, late = false, onToggleDone, onOpen }: WeekTaskItemProps) {
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
      <div className="ct-week-item" data-layout="mobile" data-done={done} data-opened={opened || undefined} data-late={late || undefined}>
        <HourCell time={task.time} />
        {checkbox}
        {title}
        {/* UI-FIX-07 (PRD-02, lot C, réserve d'Ali) : la marque d'objectif est de l'information, elle reste sur la ligne iPhone (OB-03 critère 3). */}
        {task.goalId && <TaskGoalMark size={14} />}
        {late && <span className="ct-week-item__late">{tWeekRefonte('lateMark')}</span>}
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
  /** Espaces et filtre « Tout » : l'espace est écrit après « Routine » sur PC (ES-03). */
  readonly spaces: readonly Space[];
  readonly showSpace: boolean;
  /** Une source de routines sait valider (R-03) : la case est affichée. */
  readonly checkable: boolean;
  /** Jour futur : seuls aujourd'hui et les jours passés se valident (R-03 critère 11, QB-03) ; la case est inactive. */
  readonly disabled?: boolean;
  readonly onToggle: () => void;
}

/** Routine du jour (M4) : placée par son heure, jamais déplaçable (Q11) ; « 07:30 · Routine » sur PC. */
export function WeekRoutineItem({ routine, time, done, layout, spaces, showSpace, checkable, disabled = false, onToggle }: WeekRoutineItemProps) {
  const checkbox = checkable ? (
    <Checkbox
      checked={done}
      disabled={disabled}
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
        <HourCell time={time} />
        {checkbox}
        {title}
      </div>
    );
  }
  return (
    <div className="ct-week-item" data-layout="pc" data-done={done} data-kind="routine">
      {checkbox}
      <div className="ct-week-item__body">
        {title}
        <span className="ct-week-item__sub">{routineSubtitle(routine, time, { spaces, showSpace })}</span>
      </div>
    </div>
  );
}

export interface WeekChecklistItemProps {
  readonly summary: ChecklistSummary;
  readonly layout: Layout;
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace est écrit dans la sous-ligne, dans sa couleur (C-03 critère 7). */
  readonly showSpace: boolean;
  /** Ouvre l'onglet Checklists sur cette checklist (C-03 critère 3). */
  readonly onOpen: () => void;
}

/**
 * Checklist du jour (C-03) : icône à la place de la case (une checklist n'est pas terminée d'un geste, ses items se cochent dans
 * l'onglet Checklists), titre, « checklist 0/8 » (PC-Semaine.html : « Perso · checklist 0/8 ») ; sur iPhone, tiret, icône, titre, « 0/8 ».
 */
export function WeekChecklistItem({ summary, layout, spaces, showSpace, onOpen }: WeekChecklistItemProps) {
  const { checklist, checked, total } = summary;
  const space = showSpace ? spaces.find((candidate) => candidate.id === checklist.spaceId) : undefined;
  const title = (
    <button type="button" className="ct-week-item__title" aria-label={t('checklists.openFromList', { title: checklist.title })} onClick={onOpen}>
      {checklist.title}
    </button>
  );
  if (layout === 'mobile') {
    return (
      <div className="ct-week-item" data-layout="mobile" data-kind="checklist">
        <HourCell time={null} />
        <ChecklistIcon icon={checklist.icon} size={20} />
        {title}
        <span className="ct-week-item__count" aria-label={t('today.checklistProgress', { checked, total })}>
          {checked}/{total}
        </span>
      </div>
    );
  }
  return (
    <div className="ct-week-item" data-layout="pc" data-kind="checklist">
      <ChecklistIcon icon={checklist.icon} size={18} />
      <div className="ct-week-item__body">
        {title}
        <span className="ct-week-item__sub">
          {space && (
            <>
              <span style={{ color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-semibold)' }}>{space.name}</span>
              {' · '}
            </>
          )}
          {t('checklists.weekSubtitle', { checked, total })}
        </span>
      </div>
    </div>
  );
}

export interface WeekEventItemProps {
  readonly event: TodayEventEntry;
  readonly layout: Layout;
  /** Ouvre la fiche de l'événement (lecture seule pour un agenda externe, S-05 ; modifiable pour un événement local) ; absent : non interactif. */
  readonly onOpen?: () => void;
  /** Compte à rebours d'un événement important (E-04 critère 4) : « J-2 » ou « Aujourd'hui » ; null : aucun. */
  readonly countdown?: CountdownTag | null;
}

/**
 * Événement du jour, lecture seule : sans case, sans poignée, jamais déplaçable. PC : externe (agenda lu par M8) sur fond #E3EEF5 avec le
 * nom de l'agenda, interne (M7) sur fond distinct (anniversaire, #FBE7E4) ; annoncé « Événement, lecture seule » quand il ne s'ouvre pas.
 * iPhone (UI-REFONTE-03) : heure dans la colonne, rond au trait de la couleur des événements (anniversaire, férié : leurs couleurs), titre.
 */
export function WeekEventItem({ event, layout, onOpen, countdown = null }: WeekEventItemProps) {
  const holiday = event.kind === 'holiday';
  const external = event.calendarName !== null && !holiday;
  const when = event.allDay ? null : event.startTime;
  const source = holiday ? 'holiday' : external ? 'external' : 'local';
  const readOnly = external || holiday ? <span className="ct-visually-hidden">{`, ${t('week.eventReadOnly')}`}</span> : null;
  const interactive = onOpen !== undefined;
  const props = { className: 'ct-week-event', 'data-layout': layout, 'data-source': source };
  const tag = countdown && (
    <span className="ct-week-event__tag" data-tag={countdown.kind}>
      <span aria-hidden={countdown.spoken ? 'true' : undefined}>{countdown.label}</span>
      {countdown.spoken && <span className="ct-visually-hidden">{countdown.spoken}</span>}
    </span>
  );
  const content =
    layout === 'mobile' ? (
      <>
        <HourCell time={when} />
        <span className="ct-week-event__mark" data-kind={event.kind ?? source} aria-hidden="true" />
        <span className="ct-week-item__title">{event.title}</span>
        {tag}
        {readOnly}
      </>
    ) : (
      <>
        <span className="ct-week-item__title">{when ? `${when} ${event.title}` : event.title}</span>
        {(event.allDay || event.calendarName) && (
          <span className="ct-week-event__source">{[event.allDay ? t('today.eventAllDay') : null, event.calendarName].filter(Boolean).join(' · ')}</span>
        )}
        {tag}
        {readOnly}
      </>
    );
  return interactive ? (
    <button type="button" {...props} onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div {...props}>{content}</div>
  );
}
