import { ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { IconRef, Routine, RoutineFields, RoutineScheduleType, Space } from '../../domain/model';
import { weekdayOf } from '../../domain/localDate';
import {
  clampInterval,
  intervalBounds,
  ROUTINE_TITLE_MAX_LENGTH,
  TIMES_PER_WEEK_MAX,
  TIMES_PER_WEEK_MIN,
  validateRoutine,
} from '../../domain/routineRules';
import { nextOccurrences } from '../../domain/routineSchedule';
import type { LocalDate, SpaceId, Weekday } from '../../domain/types';
import { t } from '../../i18n';
import { formatDetailDate } from '../../i18n/format';
import { formatNextOccurrences, weekdayName } from '../../i18n/formatRoutine';
import { Button, DatePicker, Icon, IconChooser, TextField, useLayout } from '../../ui';
import './RoutineForm.css';

/** Choix du sélecteur « Fréquence » : les cinq types de la base, « Tous les N jours » regroupant jours et semaines (R-07). */
export type FrequencyChoice = 'daily' | 'weekdays' | 'x_per_week' | 'every_n';

const CHOICES: readonly FrequencyChoice[] = ['daily', 'weekdays', 'x_per_week', 'every_n'];

/** Unité de « Tous les N » : jours ou semaines. */
type IntervalUnit = 'days' | 'weeks';

/** Nombre de prochaines dates montrées sous « Tous les N » (R-07 critère 3). */
const PREVIEW_COUNT = 4;

function choiceOf(routine: Routine | null): FrequencyChoice {
  if (!routine) return 'daily';
  return routine.scheduleType === 'every_n_days' || routine.scheduleType === 'every_n_weeks' ? 'every_n' : routine.scheduleType;
}
const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

const FREQUENCY_LABELS = {
  daily: 'routines.form.daily',
  weekdays: 'routines.form.weekdays',
  x_per_week: 'routines.form.xPerWeek',
  every_n: 'routines.form.everyN',
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
  const layout = useLayout();
  const [choice, setChoice] = useState<FrequencyChoice>(choiceOf(routine));
  const [weekdays, setWeekdays] = useState<readonly Weekday[]>(routine?.weekdays ?? []);
  // Jours de « Toutes les N semaines » : tant que l'utilisateur n'y touche pas, ils suivent le jour de la date de départ (QB-04).
  const [daysTouched, setDaysTouched] = useState(routine !== null);
  const [timesPerWeek, setTimesPerWeek] = useState(routine?.timesPerWeek ?? 3);
  const [unit, setUnit] = useState<IntervalUnit>(routine?.scheduleType === 'every_n_weeks' ? 'weeks' : 'days');
  const [interval, setIntervalValue] = useState(routine?.interval ?? 2);
  const [startDate, setStartDate] = useState<LocalDate>(routine?.startDate ?? today);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [spaceId, setSpaceId] = useState<SpaceId>(routine?.spaceId ?? initialSpaceId);
  const [saving, setSaving] = useState(false);

  const scheduleType: RoutineScheduleType = choice === 'every_n' ? (unit === 'days' ? 'every_n_days' : 'every_n_weeks') : choice;
  const fields: RoutineFields = {
    spaceId,
    title,
    icon,
    scheduleType,
    weekdays,
    timesPerWeek: choice === 'x_per_week' ? timesPerWeek : null,
    interval: choice === 'every_n' ? interval : null,
    startDate: choice === 'every_n' ? startDate : (routine?.startDate ?? today),
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
    setDaysTouched(true);
    setWeekdays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]));
  }

  /** « Toutes les N semaines » : jours préréglés sur le jour de la date de départ (QB-04) tant qu'ils ne sont pas modifiés. */
  function presetDays(nextUnit: IntervalUnit, date: LocalDate): void {
    if (nextUnit === 'weeks' && !daysTouched) setWeekdays([weekdayOf(date)]);
  }

  function chooseFrequency(next: FrequencyChoice): void {
    setChoice(next);
    if (next === 'every_n') presetDays(unit, startDate);
  }

  function chooseUnit(next: IntervalUnit): void {
    if (next === unit) return;
    setUnit(next);
    setIntervalValue((n) => clampInterval(next === 'days' ? 'every_n_days' : 'every_n_weeks', n));
    presetDays(next, startDate);
  }

  function chooseStart(date: LocalDate): void {
    setStartDate(date);
    presetDays(unit, date);
  }

  const bounds = intervalBounds(unit === 'days' ? 'every_n_days' : 'every_n_weeks');
  const nextDates = choice === 'every_n' && valid ? nextOccurrences(fields, today, PREVIEW_COUNT) : [];

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
          onChange={(event) => chooseFrequency(event.target.value as FrequencyChoice)}
          className="ct-routine-form__selectControl"
        >
          {CHOICES.map((value) => (
            <option key={value} value={value}>
              {t(FREQUENCY_LABELS[value])}
            </option>
          ))}
        </select>
      </label>

      {choice === 'every_n' && bounds && (
        <div className="ct-routine-form__every">
          <div role="group" aria-label={t('routines.form.everyLabel')} className="ct-routine-form__everyRow">
            <span className="ct-routine-form__everyText">{t('routines.form.everyPrefix')}</span>
            <button
              type="button"
              className="ct-routine-form__step"
              aria-label={t('routines.form.decrease')}
              disabled={interval <= bounds.min}
              onClick={() => setIntervalValue((n) => Math.max(bounds.min, n - 1))}
            >
              −
            </button>
            <span className="ct-routine-form__times" aria-live="polite" data-testid="interval-value">
              {interval}
            </span>
            <button
              type="button"
              className="ct-routine-form__step"
              aria-label={t('routines.form.increase')}
              disabled={interval >= bounds.max}
              onClick={() => setIntervalValue((n) => Math.min(bounds.max, n + 1))}
            >
              +
            </button>
            <div role="group" aria-label={t('routines.form.unitLabel')} className="ct-routine-form__unit">
              {(['days', 'weeks'] as const).map((value) => (
                <button key={value} type="button" aria-pressed={unit === value} className="ct-routine-form__unitButton" onClick={() => chooseUnit(value)}>
                  {t(value === 'days' ? 'routines.form.unitDays' : 'routines.form.unitWeeks')}
                </button>
              ))}
            </div>
          </div>
          <div className="ct-routine-form__startRow">
            <span className="ct-routine-form__startLabel">{t('routines.form.startLabel')}</span>
            {layout === 'pc' ? (
              <DatePicker
                value={{ date: startDate, time: null }}
                today={today}
                allowSomeday={false}
                showTime={false}
                label={t('routines.form.startField')}
                className="ct-routine-form__startPicker"
                onChange={(next) => {
                  if (next?.date) chooseStart(next.date);
                }}
              />
            ) : (
              <button type="button" className="ct-routine-form__startButton" aria-expanded={startPickerOpen} onClick={() => setStartPickerOpen((open) => !open)}>
                {formatDetailDate(startDate, false)}
              </button>
            )}
          </div>
          {layout === 'mobile' && startPickerOpen && (
            <DatePicker
              value={{ date: startDate, time: null }}
              today={today}
              allowSomeday={false}
              showTime={false}
              onChange={(next) => {
                if (next?.date) chooseStart(next.date);
              }}
            />
          )}
          {nextDates.length > 0 && <span className="ct-routine-form__preview">{t('routines.form.nextTimes', { dates: formatNextOccurrences(nextDates) })}</span>}
        </div>
      )}

      {(choice === 'weekdays' || (choice === 'every_n' && unit === 'weeks')) && (
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
