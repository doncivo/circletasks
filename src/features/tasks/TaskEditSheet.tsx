import { X } from 'lucide-react';
import { useState, type CSSProperties, type FormEvent } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Space, Task, TaskPatch } from '../../domain/model';
import { ruleChanged } from '../../domain/recurrenceEdit';
import { sortReminderOffsets, toggleReminderOffset } from '../../domain/reminders';
import { choiceOfTask, editSheetPatch } from '../../domain/taskDetailEdit';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { LocalDate, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { ReminderBlock } from '../reminders';
import { Button, DatePicker, Icon, IconChooser, RecurrencePicker, Sheet, TextField } from '../../ui';

/** Résultat de la feuille : champs modifiés, et règle de répétition si elle a changé (`null` : « Une fois »). */
export interface EditSheetResult {
  readonly patch: TaskPatch;
  readonly rule: RecurrenceFields | null | undefined;
  /** Avances des rappels si elles ont changé (N-02), undefined sinon. */
  readonly reminders?: readonly ReminderOffsetMin[] | undefined;
}

export interface TaskEditSheetProps {
  readonly task: Task;
  readonly spaces: readonly Space[];
  readonly today: LocalDate;
  /** Règle actuelle de la série (T-09), null : « Une fois ». */
  readonly recurrence: RecurrenceFields | null;
  /** Avances des rappels actuels de la tâche (N-02). */
  readonly reminders: readonly ReminderOffsetMin[];
  readonly onClose: () => void;
  readonly onSave: (result: EditSheetResult) => void;
}

/**
 * Feuille « Modifier la tâche » de la fiche iPhone (A-08 critère 9, Q15) : la feuille d'ajout pré-remplie (titre, icône,
 * date et roues, répétition, espace). Enregistrer applique les changements ; fermer sans enregistrer ne change rien.
 * Rappels (N-02) : bloc grisé sans heure. Projet : à venir avec ES-04 (aucun champ simulé).
 */
export function TaskEditSheet({ task, spaces, today, recurrence, reminders, onClose, onSave }: TaskEditSheetProps) {
  const [title, setTitle] = useState(task.title);
  const [icon, setIcon] = useState<IconRef | null>(task.icon);
  const [choice, setChoice] = useState<DateChoice>(choiceOfTask(task));
  const [rule, setRule] = useState<RecurrenceFields | null>(recurrence);
  const [offsets, setOffsets] = useState<readonly ReminderOffsetMin[]>(reminders);
  const [spaceId, setSpaceId] = useState<SpaceId>(task.spaceId);
  const valid = validateTaskTitle(title);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!valid.ok) return;
    const patch = editSheetPatch(task, { title: valid.value, icon, choice, spaceId });
    const changed = rule === null ? recurrence !== null : recurrence === null || ruleChanged(recurrence, rule);
    const wanted = sortReminderOffsets(offsets);
    const remindersChanged = wanted.join() !== sortReminderOffsets(reminders).join();
    onSave({ patch, rule: changed ? rule : undefined, ...(remindersChanged && choice.time !== null && choice.date !== null ? { reminders: wanted } : {}) });
  }

  return (
    <Sheet open onClose={onClose} label={t('detail.editSheetTitle')}>
      <form className="ct-task-sheet" noValidate onSubmit={submit}>
        <div className="ct-task-sheet__header">
          <h2 className="ct-task-sheet__heading">{t('detail.editSheetTitle')}</h2>
          <button type="button" className="ct-task-sheet__close" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
        </div>
        <TextField label={t('tasks.titleLabel')} value={title} onChange={setTitle} maxLength={TASK_TITLE_MAX_LENGTH} />
        <IconChooser value={icon} onChange={setIcon} />
        <DatePicker value={choice} today={today} onChange={(next) => setChoice(next ?? { date: today, time: null })} />
        <RecurrencePicker value={choice.date === null ? null : rule} onChange={setRule} startDate={choice.date} />
        <ReminderBlock
          time={choice.date === null ? null : choice.time}
          offsets={offsets}
          onToggle={(offset) => setOffsets((current) => toggleReminderOffset(current, offset))}
        />
        <div className="ct-task-sheet__spaces" role="group" aria-label={t('detail.spaceChoiceLabel')}>
          {spaces.map((space) => (
            <button
              key={space.id}
              type="button"
              aria-pressed={spaceId === space.id}
              className="ct-task-sheet__spaceButton"
              style={{ '--ct-space-color': space.color } as CSSProperties}
              onClick={() => setSpaceId(space.id)}
            >
              {space.name}
            </button>
          ))}
        </div>
        <div className="ct-task-sheet__spacer" />
        <Button type="submit" fullWidth disabled={!valid.ok}>
          {t('tasks.save')}
        </Button>
      </form>
    </Sheet>
  );
}
