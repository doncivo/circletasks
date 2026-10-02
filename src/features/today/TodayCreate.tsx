import { X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { IconRef, RecurrenceFields, Space } from '../../domain/model';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { LocalDate, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { Button, DatePicker, Icon, IconChooser, RecurrencePicker, Sheet, TextField, type Layout } from '../../ui';
import type { NewTaskSchedule } from './todayStore';

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

export interface TodayAddRowProps {
  readonly layout: Layout;
  readonly today: LocalDate;
  readonly inputRef: RefObject<HTMLInputElement>;
  /** Crée la tâche ; rend true si elle l'est (le champ se vide). */
  readonly onSubmit: (title: string, choice: DateChoice | null) => Promise<boolean>;
}

/**
 * Champ « Ajouter une tâche » (Main.html, PC-Aujourdhui.html) : pleine largeur. Sur PC, le champ « Date » à saisie libre
 * (T-14) est intégré à droite du même cadre gris ; sur iPhone, la date se règle dans la feuille « Nouvelle tâche » (Fab).
 */
export function TodayAddRow({ layout, today, inputRef, onSubmit }: TodayAddRowProps) {
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState<DateChoice | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await onSubmit(title, choice)) {
      setTitle('');
      setChoice(null);
      inputRef.current?.focus();
    }
  }

  return (
    <form className="ct-today__addRow" data-layout={layout} onSubmit={submit}>
      <TextField
        ref={inputRef}
        label={t('tasks.newTask')}
        placeholder={t(layout === 'pc' ? 'tasks.addPlaceholderPc' : 'tasks.addPlaceholder')}
        value={title}
        onChange={setTitle}
        maxLength={TASK_TITLE_MAX_LENGTH}
        className="ct-today__addField"
      />
      {layout === 'pc' && <DatePicker value={choice} today={today} onChange={setChoice} className="ct-today__dateField" />}
      {/* Bouton d'envoi masqué : avec deux champs texte (titre, date), Entrée ne soumet le formulaire que par lui. */}
      <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
    </form>
  );
}

export interface TodayCreateSheetProps {
  readonly viewedDate: LocalDate;
  readonly today: LocalDate;
  readonly spaces: readonly Space[];
  /** Espace présélectionné (filtre actif, ES-02). */
  readonly initialSpaceId: SpaceId | null;
  readonly onClose: () => void;
  readonly onCreate: (input: { title: string; spaceId: SpaceId; choice: DateChoice; recurrence: RecurrenceFields | null; icon: IconRef | null }) => Promise<boolean>;
}

/**
 * Feuille « Nouvelle tâche » (iPhone, Ajout.html) : titre, icône, roues de date (« Aujourd'hui » / jour affiché, sans heure,
 * Q9), répétition, espace. Montée à l'ouverture seulement : son état part de zéro à chaque fois.
 */
export function TodayCreateSheet({ viewedDate, today, spaces, initialSpaceId, onClose, onCreate }: TodayCreateSheetProps) {
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState<DateChoice>({ date: viewedDate, time: null });
  const [spaceId, setSpaceId] = useState<SpaceId | null>(initialSpaceId);
  const [icon, setIcon] = useState<IconRef | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceFields | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const valid = validateTaskTitle(title).ok;

  // Le piège de focus de `Sheet` pose d'abord le focus sur « Fermer » (premier élément focusable) ; le `setTimeout` s'exécute
  // après ses effets pour poser le focus dans le champ Titre sans dépendre de l'ordre du DOM.
  useEffect(() => {
    const id = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid || !spaceId) return;
    if (await onCreate({ title, spaceId, choice, recurrence: choice.date === null ? null : recurrence, icon })) onClose();
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
        <TextField ref={titleRef} label={t('tasks.titleLabel')} value={title} onChange={setTitle} maxLength={TASK_TITLE_MAX_LENGTH} />
        {/* Choix Icône / Emoji (T-03, Ajout.html). */}
        <IconChooser value={icon} onChange={setIcon} />
        {/* Puces et roues jour / heure / minutes (T-14, Ajout.html). */}
        <DatePicker value={choice} today={today} onChange={(next) => setChoice(next ?? { date: today, time: null })} />
        <RecurrencePicker value={recurrence} onChange={setRecurrence} startDate={choice.date ?? viewedDate} />
        <div className="ct-task-sheet__spaces" role="group" aria-label={t('spaces.filterLabel')}>
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
        <Button type="submit" fullWidth disabled={!valid || !spaceId}>
          {t('tasks.save')}
        </Button>
      </form>
    </Sheet>
  );
}
