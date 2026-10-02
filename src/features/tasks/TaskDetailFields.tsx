import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { parseTimeInput } from '../../domain/dateInput';
import type { RecurrenceFields, ReminderOffsetMin, Space, Task, TaskPatch } from '../../domain/model';
import { choiceOfTask, patchFromDateChoice } from '../../domain/taskDetailEdit';
import type { LocalDate } from '../../domain/types';
import { t, tDynamic } from '../../i18n';
import { formatDetailDate } from '../../i18n/format';
import { DateEditor, TextField, spaceTextColor, type Layout } from '../../ui';
import { DetailRow } from './DetailRow';
import { TaskRepeatRow } from './TaskRepeatRow';
import { useInlineCancel, type InlineCancelRef } from './useInlineCancel';

/**
 * Lignes de la fiche détail d'une tâche (A-08, PC-Aujourdhui.html, Detail.html) : date, heure, répétition, rappels, espace, projet,
 * objectif. PC : texte, édité sur place au clic sur la valeur (date : champ « Date » et calendrier ; heure ; espace ; Entrée valide,
 * Échap annule, enregistrement immédiat). iPhone : lecture seule, sauf la répétition (ligne cliquable) ; le reste passe par la feuille
 * « Modifier la tâche » (Q15). Rappels, projet et objectif : affichage seulement (N-02, ES-04, OB-03 en gèrent l'édition).
 */

/** Texte de la date : « Mer. 23 sept. 2026 » (PC), « Mer. 23 sept. » (iPhone, année courante omise), « Un jour » ou « Sans date ». */
export function dateValueText(task: Pick<Task, 'date' | 'someday'>, today: LocalDate, withYear: boolean): string {
  if (task.someday) return t('detail.somedayValue');
  if (!task.date) return t('detail.noDate');
  return formatDetailDate(task.date, withYear || task.date.slice(0, 4) !== today.slice(0, 4));
}

const offsetLabel = (offset: ReminderOffsetMin): string => tDynamic(`detail.reminderOffset${String(offset)}` as 'detail.reminderOffset0');

function ReminderChips({ reminders }: { reminders: readonly ReminderOffsetMin[] }) {
  if (reminders.length === 0) return <>{t('detail.remindersNone')}</>;
  return (
    <span className="ct-task-detail__chips">
      {reminders.map((offset) => (
        <span key={offset} className="ct-task-detail__chip">
          {offsetLabel(offset)}
        </span>
      ))}
    </span>
  );
}

interface InlineProps {
  readonly task: Task;
  readonly onPatch: (patch: TaskPatch) => void;
  readonly cancelInlineRef: InlineCancelRef;
}

/** Date éditable (PC) : la valeur devient le champ « Date » à saisie libre avec calendrier (PC-Date.html). */
function DateValue({ task, today, onPatch, cancelInlineRef }: InlineProps & { today: LocalDate }) {
  const [editing, setEditing] = useState(false);
  useInlineCancel(cancelInlineRef, editing, () => setEditing(false));
  const choice = choiceOfTask(task);
  if (!editing) {
    return (
      <button type="button" className="ct-task-detail__valueButton" aria-label={`${t('detail.dateFieldLabel')} : ${dateValueText(task, today, true)}`} onClick={() => setEditing(true)}>
        {dateValueText(task, today, true)}
      </button>
    );
  }
  return (
    <DateEditor
      mode="popover"
      value={choice}
      today={today}
      autoFocus
      commitOnPick
      label={t('detail.dateFieldLabel')}
      onCancel={() => setEditing(false)}
      onCommit={(next) => {
        setEditing(false);
        if (next !== null && (next.date !== choice.date || next.time !== choice.time)) onPatch(patchFromDateChoice(next));
      }}
    />
  );
}

/** Heure éditable (PC) : « 9h30 », « 09:30 », vide = sans heure ; Entrée valide, Échap annule. */
function TimeValue({ task, onPatch, cancelInlineRef }: InlineProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  useInlineCancel(cancelInlineRef, editing, () => setEditing(false));
  const text = task.time ?? t('detail.noTime');

  if (!editing) {
    // Sans date, l'heure n'a pas de sens (invariant T-02) : texte seul.
    if (task.date === null) return <>{text}</>;
    return (
      <button
        type="button"
        className="ct-task-detail__valueButton"
        aria-label={`${t('detail.timeEditLabel')} : ${text}`}
        onClick={() => {
          setDraft(task.time ?? '');
          setInvalid(false);
          setEditing(true);
        }}
      >
        {text}
      </button>
    );
  }

  function commit(event?: FormEvent): void {
    event?.preventDefault();
    const parsed = parseTimeInput(draft);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setEditing(false);
    if (parsed.value !== task.time) onPatch({ time: parsed.value });
  }

  return (
    <form onSubmit={commit} onKeyDown={(event: KeyboardEvent) => event.key === 'Escape' && event.stopPropagation()}>
      <TextField label={t('detail.timeEditLabel')} value={draft} onChange={setDraft} onBlur={() => commit()} placeholder={t('detail.noTime')} autoFocus />
      {invalid && (
        <span role="alert" className="ct-task-detail__fieldError">
          {t('detail.timeInvalid')}
        </span>
      )}
    </form>
  );
}

/** Espace éditable (PC) : le nom coloré devient les pastilles Pro / Perso ; un choix s'applique aussitôt. */
function SpaceValue({ task, spaces, onPatch, cancelInlineRef }: InlineProps & { spaces: readonly Space[] }) {
  const [editing, setEditing] = useState(false);
  useInlineCancel(cancelInlineRef, editing, () => setEditing(false));
  const current = spaces.find((space) => space.id === task.spaceId);
  if (!editing) {
    return (
      <button
        type="button"
        className="ct-task-detail__valueButton ct-task-detail__spaceName"
        style={current ? { color: spaceTextColor(current.color) } : undefined}
        aria-label={`${t('detail.spaceChoiceLabel')} : ${current?.name ?? ''}`}
        onClick={() => setEditing(true)}
      >
        {current?.name}
      </button>
    );
  }
  return (
    <span role="group" aria-label={t('detail.spaceChoiceLabel')} className="ct-task-detail__spaces">
      {spaces.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          aria-pressed={candidate.id === task.spaceId}
          className="ct-task-detail__spaceButton"
          style={{ color: spaceTextColor(candidate.color) }}
          onClick={() => {
            setEditing(false);
            if (candidate.id !== task.spaceId) onPatch({ spaceId: candidate.id, projectId: null });
          }}
        >
          {candidate.name}
        </button>
      ))}
    </span>
  );
}

export interface TaskDetailFieldsProps {
  readonly task: Task;
  readonly layout: Layout;
  readonly spaces: readonly Space[];
  readonly today: LocalDate;
  readonly reminders: readonly ReminderOffsetMin[];
  readonly goalTitle: string | null;
  readonly recurrence: RecurrenceFields | null;
  /** Applique une modification (la question « cette occurrence / toutes les suivantes » est posée par la fiche). */
  readonly onPatch: (patch: TaskPatch) => void;
  /** Saisie en place en cours : Échap l'annule avant de fermer la fiche. */
  readonly cancelInlineRef: InlineCancelRef;
  readonly setRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  readonly updateRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  readonly stopRecurrence: () => Promise<boolean>;
}

export function TaskDetailFields({ task, layout, spaces, today, reminders, goalTitle, recurrence, onPatch, cancelInlineRef, setRecurrence, updateRecurrence, stopRecurrence }: TaskDetailFieldsProps) {
  const space = spaces.find((candidate) => candidate.id === task.spaceId);
  const inline: InlineProps = { task, onPatch, cancelInlineRef };
  const repeat: ReactNode = <TaskRepeatRow task={task} recurrence={recurrence} setRecurrence={setRecurrence} updateRecurrence={updateRecurrence} stopRecurrence={stopRecurrence} />;
  const goal = goalTitle ?? t('detail.goalNone');

  if (layout === 'mobile') {
    const date = dateValueText(task, today, false);
    return (
      <div className="ct-task-detail__fields">
        <DetailRow label={t('detail.dateRow')}>{task.time ? `${date} · ${task.time}` : date}</DetailRow>
        {repeat}
        <DetailRow label={t('detail.remindersRow')}>
          <ReminderChips reminders={reminders} />
        </DetailRow>
        <DetailRow label={t('detail.spaceProjectRow')}>
          <span style={space ? { color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-bold)' } : undefined}>{space?.name}</span>
          {' · '}
          {t('detail.projectNone')}
        </DetailRow>
        <DetailRow label={t('detail.goalRow')}>{goal}</DetailRow>
      </div>
    );
  }

  return (
    <div className="ct-task-detail__fields">
      <DetailRow label={t('detail.dateRow')}>
        <DateValue {...inline} today={today} />
      </DetailRow>
      <DetailRow label={t('detail.timeRow')}>
        <TimeValue {...inline} />
      </DetailRow>
      {repeat}
      <DetailRow label={t('detail.remindersRow')}>
        <ReminderChips reminders={reminders} />
      </DetailRow>
      <DetailRow label={t('detail.spaceRow')}>
        <SpaceValue {...inline} spaces={spaces} />
      </DetailRow>
      <DetailRow label={t('detail.projectRow')}>{t('detail.projectNone')}</DetailRow>
      <DetailRow label={t('detail.goalRow')}>{goal}</DetailRow>
    </div>
  );
}
