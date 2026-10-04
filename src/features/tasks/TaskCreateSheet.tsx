import { X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Space } from '../../domain/model';
import { offsetsAfterTimeChange, toggleReminderOffset } from '../../domain/reminders';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { GoalId, LocalDate, ProjectId, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { AddSegments, Button, DatePicker, Icon, IconChooser, QuickInputField, QuickPreview, RecurrencePicker, Sheet, SpaceSegmented, type AddSegment } from '../../ui';
import { useQuickInput } from '../capture';
import { GoalAttachSwitch } from '../goals/GoalAttachSwitch';
import { ReminderBlock } from '../reminders';
import { ProjectSelect } from '../spaces';
import type { NewTaskSchedule } from './taskUseCases';

/**
 * Planification choisie dans le sélecteur de date (T-14) : aucun choix = jour affiché ; « Un jour » = tâche
 * sans date ; sinon date et heure optionnelle.
 */
export function scheduleOf(choice: DateChoice | null): NewTaskSchedule {
  // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `date` / `time` que lorsqu'une valeur est choisie.
  if (choice === null) return {};
  if (choice.date === null) return { someday: true };
  return { date: choice.date, ...(choice.time !== null ? { time: choice.time } : {}) };
}

export interface TaskCreateSheetProps {
  readonly viewedDate: LocalDate;
  readonly today: LocalDate;
  readonly spaces: readonly Space[];
  /** Espace présélectionné (filtre actif, ES-02). */
  readonly initialSpaceId: SpaceId | null;
  /** Projet présélectionné (filtre projet actif, QB-15) ; seulement s'il appartient à l'espace présélectionné. */
  readonly initialProjectId?: ProjectId | null;
  /** Avances cochées d'office à la première heure donnée (`reminders.defaultOffsets`, QB-08) ; [0] par défaut. */
  readonly defaultOffsets?: readonly ReminderOffsetMin[];
  /** « Un jour » présélectionné (SD-01 critère 5 : bouton « + » de l'écran Un jour) : roues et champ de date masqués d'office. */
  readonly initialSomeday?: boolean;
  /** Titre déjà saisi dans un autre segment de la feuille Ajout (E-01 critère 2 : changer de segment conserve le titre). */
  readonly initialTitle?: string;
  /** Affiche les segments Tâche / Événement / Routine ; appelé avec le segment choisi et le titre saisi. */
  readonly onSegmentChange?: (segment: AddSegment, title: string) => void;
  readonly onClose: () => void;
  readonly onCreate: (input: {
    title: string;
    spaceId: SpaceId;
    projectId: ProjectId | null;
    choice: DateChoice;
    recurrence: RecurrenceFields | null;
    icon: IconRef | null;
    reminderOffsets: readonly ReminderOffsetMin[];
    /** OB-03 : objectif auquel la tâche est rattachée à sa création. */
    goalId: GoalId | null;
  }) => Promise<boolean>;
}

/**
 * Feuille « Nouvelle tâche » (iPhone, Ajout.html) : titre, icône, roues de date (« Aujourd'hui » / jour affiché, sans heure,
 * Q9), répétition, espace. Montée à l'ouverture seulement : son état part de zéro à chaque fois.
 */
export function TaskCreateSheet({ viewedDate, today, spaces, initialSpaceId, initialProjectId = null, defaultOffsets = [0], initialSomeday = false, initialTitle = '', onSegmentChange, onClose, onCreate }: TaskCreateSheetProps) {
  const [choiceTouched, setChoiceTouched] = useState(false);
  // Q-06, Q-02 : marques # et @ et date écrites dans le titre ; la date choisie à la main (roues, puces) l'emporte sur celle du texte.
  const quick = useQuickInput({ dates: !choiceTouched && !initialSomeday, initialText: initialTitle });
  const { setText: setTitle } = quick;
  const title = quick.text;
  const [choice, setChoice] = useState<DateChoice>(initialSomeday ? { date: null, time: null } : { date: viewedDate, time: null });
  const [spaceId, setSpaceId] = useState<SpaceId | null>(initialSpaceId);
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProjectId);
  const [icon, setIcon] = useState<IconRef | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceFields | null>(null);
  const [goalId, setGoalId] = useState<GoalId | null>(null);
  const [offsets, setOffsets] = useState<readonly ReminderOffsetMin[]>([]);
  const [offsetsTouched, setOffsetsTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const valid = validateTaskTitle(quick.parse.title).ok;

  // Le piège de focus de `Sheet` pose d'abord le focus sur « Fermer » (premier élément focusable) ; le `setTimeout` s'exécute
  // après ses effets pour poser le focus dans le champ Titre sans dépendre de l'ordre du DOM.
  useEffect(() => {
    const id = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  function changeChoice(next: DateChoice | null): void {
    const value = next ?? { date: today, time: null };
    setChoiceTouched(true);
    setOffsets((current) => offsetsAfterTimeChange(current, choice.date === null ? null : choice.time, value.date === null ? null : value.time, offsetsTouched, defaultOffsets));
    setChoice(value);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = quick.parseNow();
    if (!validateTaskTitle(parsed.title).ok) return;
    // Marques explicites d'abord (Q-06 D3) ; un projet réglé à la main ne suit pas dans un autre espace.
    const finalSpaceId = parsed.spaceId ?? spaceId;
    if (!finalSpaceId) return;
    const finalProjectId = parsed.projectId ?? (parsed.spaceId !== null && parsed.spaceId !== spaceId ? null : projectId);
    // Date écrite dans le titre (Q-02), seulement si rien n'a été choisi à la main.
    const written = parsed.date !== null && !choiceTouched && !initialSomeday;
    const finalChoice: DateChoice = written ? { date: parsed.date, time: parsed.time } : choice;
    const finalOffsets = written ? offsetsAfterTimeChange(offsets, null, parsed.time, offsetsTouched, defaultOffsets) : offsets;
    const reminderOffsets = finalChoice.date === null || finalChoice.time === null ? [] : finalOffsets;
    const created = await onCreate({
      title: parsed.title,
      spaceId: finalSpaceId,
      projectId: finalProjectId,
      choice: finalChoice,
      recurrence: finalChoice.date === null ? null : recurrence,
      icon,
      reminderOffsets,
      goalId,
    });
    if (created) onClose();
  }

  return (
    <Sheet open onClose={onClose} label={t('tasks.newTask')}>
      <form className="ct-task-sheet" onSubmit={submit}>
        <div className="ct-task-sheet__header">
          <h2 className="ct-task-sheet__heading">{t('tasks.newTask')}</h2>
          <button type="button" className="ct-task-sheet__close" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
        </div>
        {onSegmentChange && <AddSegments value="task" onChange={(segment) => onSegmentChange(segment, title)} />}
        <QuickInputField
          ref={titleRef}
          label={t('tasks.titleLabel')}
          placeholder={t('tasks.addPlaceholderPc')}
          value={title}
          onChange={setTitle}
          maxLength={TASK_TITLE_MAX_LENGTH}
          context={quick.suggestionContext}
        />
        <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={today} onDismiss={quick.dismiss} />
        {/* Choix Icône / Emoji (T-03, Ajout.html). */}
        <IconChooser value={icon} onChange={setIcon} />
        {/* Puces et roues jour / heure / minutes (T-14, Ajout.html). */}
        <DatePicker value={choice} today={today} onChange={changeChoice} />
        <RecurrencePicker value={recurrence} onChange={setRecurrence} startDate={choice.date ?? viewedDate} />
        {/* Rappels (N-02, Ajout.html) : grisés sans heure (QB-07) ; « À l'heure » cochée d'office à la première heure (QB-08). */}
        <ReminderBlock
          time={choice.date === null ? null : choice.time}
          offsets={offsets}
          onToggle={(offset) => {
            setOffsetsTouched(true);
            setOffsets((current) => toggleReminderOffset(current, offset));
          }}
        />
        {/* Espace puis projet (Ajout.html) : changer d'espace remet « Projet : aucun » (ES-04 critère 4). */}
        <div className="ct-task-sheet__spaceRow">
          <SpaceSegmented
            layout="compact"
            items={spaces}
            value={spaceId}
            onChange={(id) => {
              if (id !== spaceId) setProjectId(null);
              setSpaceId(id);
            }}
            label={t('detail.spaceChoiceLabel')}
          />
          <ProjectSelect spaceId={spaceId} value={projectId} onChange={setProjectId} />
        </div>
        {/* Rattacher à mon objectif (OB-03, Ajout.html) : la semaine de référence est celle de la date choisie. */}
        <GoalAttachSwitch variant="sheet" taskDate={choice.date} attachedGoalId={goalId} onChange={setGoalId} />
        <div className="ct-task-sheet__spacer" />
        <Button type="submit" fullWidth disabled={!valid || !spaceId}>
          {t('tasks.save')}
        </Button>
      </form>
    </Sheet>
  );
}
