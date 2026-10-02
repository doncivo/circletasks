import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { IconRef, Routine, RoutineFields, RoutineScheduleType, Space } from '../../domain/model';
import { TIMES_PER_WEEK_MAX, TIMES_PER_WEEK_MIN, validateRoutine, ROUTINE_TITLE_MAX_LENGTH } from '../../domain/routineRules';
import type { LocalDate, SpaceId, Weekday } from '../../domain/types';
import { t } from '../../i18n';
import { weekdayName } from '../../i18n/formatRoutine';
import { Button, Icon, IconChooser, TextField } from '../../ui';
import './RoutineForm.css';

/** Choix du sélecteur « Fréquence » : les cinq types de la base, « Tous les N jours » regroupant jours et semaines (R-07). */
export type FrequencyChoice = 'daily' | 'weekdays' | 'x_per_week';

const CHOICES: readonly FrequencyChoice[] = ['daily', 'weekdays', 'x_per_week'];
const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

const FREQUENCY_LABELS = {
  daily: 'routines.form.daily',
  weekdays: 'routines.form.weekdays',
  x_per_week: 'routines.form.xPerWeek',
} as const satisfies Record<FrequencyChoice, `routines.form.${string}`>;

export interface RoutineFormProps {
  /** Routine modifiée ; null : création. */
  readonly routine: Routine | null;
  readonly spaces: readonly Space[];
  /** Espace proposé à la création (règle de T-01 : filtre Pro / Perso, sinon Pro). */
  readonly initialSpaceId: SpaceId;
  readonly today: LocalDate;
  /** Enregistre ; renvoie vrai si c'est fait (le formulaire se ferme alors), faux sinon (il reste ouvert). */
  readonly onSubmit: (fields: RoutineFields) => Promise<boolean>;
  readonly onClose: () => void;
  /** Message d'échec d'enregistrement. */
  readonly errorMessage: string | null;
  /** Blocs propres à la modification (série, pause, archivage) insérés avant les boutons. */
  readonly editExtras?: ReactNode;
  /** Bouton « Archiver » (modification). */
  readonly archiveAction?: ReactNode;
  /** Focus dans le champ nom à l'ouverture (PC : création). */
  readonly autoFocus?: boolean;
}

/**
 * Formulaire de routine partagé création / modification (R-01, ModifierRoutine.html) : feuille sur iPhone, panneau de droite sur PC.
 * Nom, icône ou emoji, fréquence (tous les jours, jours choisis, X fois par semaine), espace. « Enregistrer » est grisé tant que le
 * nom est vide ou qu'aucun jour n'est choisi.
 */
export function RoutineForm(props: RoutineFormProps) {
  const { routine, spaces, initialSpaceId, today, onSubmit, onClose, errorMessage, editExtras, archiveAction, autoFocus } = props;
  const headingId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(routine?.title ?? '');
  const [icon, setIcon] = useState<IconRef | null>(routine?.icon ?? null);
  const [choice, setChoice] = useState<FrequencyChoice>(routine && CHOICES.includes(routine.scheduleType as FrequencyChoice) ? (routine.scheduleType as FrequencyChoice) : 'daily');
  const [weekdays, setWeekdays] = useState<readonly Weekday[]>(routine?.weekdays ?? []);
  const [timesPerWeek, setTimesPerWeek] = useState(routine?.timesPerWeek ?? 3);
  const [spaceId, setSpaceId] = useState<SpaceId>(routine?.spaceId ?? initialSpaceId);
  const [saving, setSaving] = useState(false);

  const fields: RoutineFields = {
    spaceId,
    title,
    icon,
    scheduleType: choice as RoutineScheduleType,
    weekdays,
    timesPerWeek: choice === 'x_per_week' ? timesPerWeek : null,
    interval: null,
    startDate: routine?.startDate ?? today,
    time: routine?.time ?? null,
    paused: routine?.paused ?? false,
    archived: routine?.archived ?? false,
  };
  const valid = validateRoutine(fields).ok;

  // Focus dans le nom à l'ouverture : après le piège de focus de la feuille ou du panneau, qui prend le premier élément.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [autoFocus]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSubmit(fields);
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(day: Weekday): void {
    setWeekdays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));
  }

  const heading = routine ? t('routines.form.editTitle') : t('routines.form.newTitle');
  return (
    <form className="ct-routine-form" noValidate onSubmit={(event) => void submit(event)} aria-labelledby={headingId}>
      <div className="ct-routine-form__header">
        <h2 id={headingId} className="ct-routine-form__heading">
          {heading}
        </h2>
        <button type="button" className="ct-routine-form__close" aria-label={t('routines.form.close')} onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>

      <TextField
        ref={nameRef}
        label={t('routines.form.nameLabel')}
        placeholder={t('routines.form.namePlaceholder')}
        value={title}
        onChange={setTitle}
        maxLength={ROUTINE_TITLE_MAX_LENGTH}
        className="ct-routine-form__name"
      />
      <IconChooser value={icon} onChange={setIcon} />

      <span className="ct-routine-form__label">{t('routines.form.frequency')}</span>
      <label className="ct-routine-form__select">
        <span className="ct-routine-form__selectText" aria-hidden="true">
          <span className="ct-routine-form__selectPrefix">{t('routines.form.frequencyPrefix')}</span>
          {t(FREQUENCY_LABELS[choice])}
        </span>
        <Icon icon={ChevronDown} size={18} />
        <select
          aria-label={t('routines.form.frequency')}
          value={choice}
          onChange={(event) => setChoice(event.target.value as FrequencyChoice)}
          className="ct-routine-form__selectControl"
        >
          {CHOICES.map((value) => (
            <option key={value} value={value}>
              {t(FREQUENCY_LABELS[value])}
            </option>
          ))}
        </select>
      </label>

      {choice === 'weekdays' && (
        <div role="group" aria-label={t('routines.form.weekdaysLabel')} className="ct-routine-form__days">
          {WEEK.map((day) => (
            <button
              key={day}
              type="button"
              role="checkbox"
              aria-checked={weekdays.includes(day)}
              aria-label={weekdayName(day, 'long').replace(/^./, (c) => c.toUpperCase())}
              className="ct-routine-form__day"
              onClick={() => toggleDay(day)}
            >
              {weekdayName(day, 'long').charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {choice === 'x_per_week' && (
        <div role="group" aria-label={t('routines.form.timesLabel')} className="ct-routine-form__counter">
          <button
            type="button"
            className="ct-routine-form__step"
            aria-label={t('routines.form.decrease')}
            disabled={timesPerWeek <= TIMES_PER_WEEK_MIN}
            onClick={() => setTimesPerWeek((n) => Math.max(TIMES_PER_WEEK_MIN, n - 1))}
          >
            −
          </button>
          <span className="ct-routine-form__times" aria-live="polite">
            {timesPerWeek}
          </span>
          <button
            type="button"
            className="ct-routine-form__step"
            aria-label={t('routines.form.increase')}
            disabled={timesPerWeek >= TIMES_PER_WEEK_MAX}
            onClick={() => setTimesPerWeek((n) => Math.min(TIMES_PER_WEEK_MAX, n + 1))}
          >
            +
          </button>
          <span className="ct-routine-form__timesUnit">{t('routines.form.timesUnit')}</span>
        </div>
      )}

      <div className="ct-routine-form__spaceRow">
        <span className="ct-routine-form__spaceLabel">{t('routines.form.space')}</span>
        <div className="ct-routine-form__spaces" role="group" aria-label={t('routines.form.spaceLabel')}>
          {spaces.map((space) => (
            <button
              key={space.id}
              type="button"
              aria-pressed={spaceId === space.id}
              className="ct-routine-form__spaceButton"
              style={{ '--ct-space-color': space.color } as CSSProperties}
              onClick={() => setSpaceId(space.id)}
            >
              {space.name}
            </button>
          ))}
        </div>
      </div>

      {editExtras}

      {errorMessage && (
        <p className="ct-routine-form__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="ct-routine-form__spacer" />
      <div className="ct-routine-form__actions">
        {archiveAction}
        <Button type="submit" fullWidth disabled={!valid || saving}>
          {t('routines.form.save')}
        </Button>
      </div>
    </form>
  );
}
