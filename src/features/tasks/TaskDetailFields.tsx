import { useEffect, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { parseTimeInput } from '../../domain/dateInput';
import type { ReminderOffsetMin, Space, Task, TaskPatch } from '../../domain/model';
import { choiceOfTask, patchFromDateChoice } from '../../domain/taskDetailEdit';
import type { LocalDate } from '../../domain/types';
import { t, tDynamic } from '../../i18n';
import { formatDetailDate } from '../../i18n/format';
import { DatePicker, TextField, type Layout } from '../../ui';

/**
 * Lignes de la fiche détail d'une tâche (A-08, PC-Aujourdhui.html, Detail.html) : date, heure, répétition,
 * rappels, espace, projet, objectif. PC : date, heure et espace s'éditent sur place (Entrée valide, Échap annule,
 * enregistrement immédiat) ; iPhone : lecture seule, la modification passe par la feuille « Modifier la tâche »
 * (Q15). Rappels, projet et objectif : affichage seulement (N-02, ES-04, OB-03 en gèrent l'édition).
 */

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ct-task-detail__row ct-task-detail__row--field">
      <span className="ct-task-detail__rowLabel">{label}</span>
      <span className="ct-task-detail__rowValue">{children}</span>
    </div>
  );
}

/** Texte de la date de la tâche : « Mer. 23 sept. 2026 », « Un jour » ou « Sans date ». */
export function dateValueText(task: Pick<Task, 'date' | 'someday'>): string {
  if (task.someday) return t('detail.somedayValue');
  return task.date ? formatDetailDate(task.date) : t('detail.noDate');
}

export function timeValueText(task: Pick<Task, 'time'>): string {
  return task.time ?? t('detail.noTime');
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

/** Heure éditable (PC) : « 9h30 », « 09:30 », vide = sans heure ; Entrée valide, Échap rétablit. */
function TimeEditor({ task, onPatch, cancelInlineRef }: { task: Task; onPatch: (patch: TaskPatch) => void; cancelInlineRef: MutableRefObject<(() => boolean) | null> }) {
  const [draft, setDraft] = useState(task.time ?? '');
  const [seen, setSeen] = useState(task.time);
  const [invalid, setInvalid] = useState(false);
  if (task.time !== seen) {
    setSeen(task.time);
    setDraft(task.time ?? '');
    setInvalid(false);
  }

  const dirty = draft !== (task.time ?? '') || invalid;
  // Échap pendant la saisie : la fiche annule la saisie au lieu de se fermer.
  useEffect(() => {
    if (!dirty) return undefined;
    const cancel = (): boolean => {
      setDraft(task.time ?? '');
      setInvalid(false);
      return true;
    };
    cancelInlineRef.current = cancel;
    return () => {
      if (cancelInlineRef.current === cancel) cancelInlineRef.current = null;
    };
  }, [dirty, task.time, cancelInlineRef]);

  function commit(): void {
    const parsed = parseTimeInput(draft);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed.value !== task.time) onPatch({ time: parsed.value });
    else setDraft(task.time ?? '');
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && dirty) {
      event.stopPropagation(); // annule la saisie sans fermer la fiche
      setDraft(task.time ?? '');
      setInvalid(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
      onKeyDown={onKeyDown}
    >
      <TextField label={t('detail.timeEditLabel')} value={draft} onChange={setDraft} onBlur={commit} disabled={task.date === null} placeholder={t('detail.noTime')} />
      {invalid && (
        <span role="alert" className="ct-task-detail__fieldError">
          {t('detail.timeInvalid')}
        </span>
      )}
    </form>
  );
}

export interface TaskDetailFieldsProps {
  readonly task: Task;
  readonly layout: Layout;
  readonly spaces: readonly Space[];
  readonly today: LocalDate;
  readonly reminders: readonly ReminderOffsetMin[];
  readonly goalTitle: string | null;
  /** Applique une modification (la question « cette occurrence / toutes les suivantes » est posée par la fiche). */
  readonly onPatch: (patch: TaskPatch) => void;
  /** Saisie en place en cours (heure) : Échap l'annule avant de fermer la fiche. */
  readonly cancelInlineRef: MutableRefObject<(() => boolean) | null>;
  /** Section « Répétition » (T-09, T-10), insérée entre l'heure et les rappels. */
  readonly repeat: ReactNode;
}

export function TaskDetailFields({ task, layout, spaces, today, reminders, goalTitle, onPatch, cancelInlineRef, repeat }: TaskDetailFieldsProps) {
  const space = spaces.find((candidate) => candidate.id === task.spaceId);
  const projectText = t('detail.projectNone');
  const goalText = goalTitle ?? t('detail.goalNone');

  if (layout === 'mobile') {
    return (
      <div className="ct-task-detail__fields">
        <DetailRow label={t('detail.dateTimeRow')}>{task.time ? `${dateValueText(task)} · ${task.time}` : dateValueText(task)}</DetailRow>
        {repeat}
        <DetailRow label={t('detail.remindersRow')}>
          <ReminderChips reminders={reminders} />
        </DetailRow>
        <DetailRow label={t('detail.spaceProjectRow')}>
          <span style={space ? { color: space.color, fontWeight: 'var(--ct-font-weight-bold)' } : undefined}>{space?.name}</span>
          {' · '}
          {projectText}
        </DetailRow>
        <DetailRow label={t('detail.goalRow')}>{goalText}</DetailRow>
      </div>
    );
  }

  const choice = choiceOfTask(task);
  return (
    <div className="ct-task-detail__fields">
      <DetailRow label={t('detail.dateRow')}>
        <DatePicker
          value={choice}
          today={today}
          label={t('detail.dateFieldLabel')}
          onChange={(next) => {
            if (next === null || (next.date === choice.date && next.time === choice.time)) return;
            onPatch(patchFromDateChoice(next));
          }}
        />
      </DetailRow>
      <DetailRow label={t('detail.timeRow')}>
        <TimeEditor task={task} onPatch={onPatch} cancelInlineRef={cancelInlineRef} />
      </DetailRow>
      {repeat}
      <DetailRow label={t('detail.remindersRow')}>
        <ReminderChips reminders={reminders} />
      </DetailRow>
      <DetailRow label={t('detail.spaceRow')}>
        <span role="group" aria-label={t('detail.spaceChoiceLabel')} className="ct-task-detail__spaces">
          {spaces.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={candidate.id === task.spaceId}
              className="ct-task-detail__spaceButton"
              style={{ color: candidate.color }}
              onClick={() => {
                if (candidate.id !== task.spaceId) onPatch({ spaceId: candidate.id, projectId: null });
              }}
            >
              {candidate.name}
            </button>
          ))}
        </span>
      </DetailRow>
      <DetailRow label={t('detail.projectRow')}>{projectText}</DetailRow>
      <DetailRow label={t('detail.goalRow')}>{goalText}</DetailRow>
    </div>
  );
}
