import { useEffect, useId, useRef, useState } from 'react';
import type { RecurrenceFields } from '../domain/model';
import { weekdayOf, parseLocalDate } from '../domain/localDate';
import { defaultRecurrence } from '../domain/recurrenceRules';
import { recurrenceLabel } from '../domain/recurrenceLabel';
import type { LocalDate, Weekday } from '../domain/types';
import { t } from '../i18n';
import { formatMessageRef } from '../i18n/formatRecurrence';
import './RecurrencePicker.css';

export interface RecurrencePickerProps {
  /** Règle choisie, ou `null` (« Une fois »). */
  value: RecurrenceFields | null;
  onChange: (rule: RecurrenceFields | null) => void;
  /** Date de départ de la tâche ; `null` : la répétition est inactive (T-09 critère 5). */
  startDate: LocalDate | null;
  className?: string;
}

type Choice = 'once' | 'weekly' | 'monthly' | 'yearly';

const CHOICES: readonly { id: Choice; labelKey: 'tasks.repeatOnce' | 'tasks.repeatWeekly' | 'tasks.repeatMonthly' | 'tasks.repeatYearly' }[] = [
  { id: 'once', labelKey: 'tasks.repeatOnce' },
  { id: 'weekly', labelKey: 'tasks.repeatWeekly' },
  { id: 'monthly', labelKey: 'tasks.repeatMonthly' },
  { id: 'yearly', labelKey: 'tasks.repeatYearly' },
];

const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const NTH_VALUES = [1, 2, 3, 4, -1] as const;
const ORDINAL_KEYS = ['first', 'second', 'third', 'fourth'] as const;

/** Radio « Une fois / Hebdo / Mensuel / Annuel » qui correspond à la règle ; `null` : règle personnalisée. */
function choiceOf(rule: RecurrenceFields | null): Choice | null {
  if (rule === null) return 'once';
  if (rule.interval !== 1) return null;
  if (rule.freq === 'weekly') return 'weekly';
  if (rule.freq === 'monthly' && rule.nthWeekday === null) return 'monthly';
  if (rule.freq === 'yearly') return 'yearly';
  return null;
}

/** Règle équivalente pour une nouvelle date de départ (jour par défaut suivi, choix de l'utilisateur conservés). */
function rebase(rule: RecurrenceFields, from: LocalDate, to: LocalDate): RecurrenceFields {
  if (rule.freq === 'weekly' && rule.weekdays.length === 1 && rule.weekdays[0] === weekdayOf(from)) {
    return { ...rule, weekdays: [weekdayOf(to)] };
  }
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && rule.monthDay === parseLocalDate(from).day) {
    return { ...rule, monthDay: parseLocalDate(to).day };
  }
  return rule;
}

/**
 * Section « Répétition » de la saisie (Ajout.html, T-09) : radios « Une fois » (défaut), « Hebdo »,
 * « Mensuel », « Annuel », jours de la semaine pour Hebdo, et lien « Autre » (tous les N jours,
 * Nᵉ jour de la semaine du mois). Contrôlé : la règle est calculée par src/domain
 * (`defaultRecurrence`), la fin (date, nombre de fois) relève de T-10.
 */
export function RecurrencePicker({ value, onChange, startDate, className }: RecurrencePickerProps) {
  const labelId = useId();
  const [otherOpen, setOtherOpen] = useState(false);
  const [daysDraft, setDaysDraft] = useState('');
  const previousStart = useRef<LocalDate | null>(startDate);

  // La date de la tâche change : une règle devient inactive sans date, sinon elle suit le nouveau jour par défaut.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    const from = previousStart.current;
    previousStart.current = startDate;
    if (from === startDate || value === null) return;
    if (startDate === null) onChangeRef.current(null);
    else if (from !== null) onChangeRef.current(rebase(value, from, startDate));
  }, [startDate, value]);

  const disabled = startDate === null;
  const current = choiceOf(value);
  const custom = value !== null && current === null;
  const showOther = otherOpen || custom;

  function choose(choice: Choice): void {
    if (startDate === null) return;
    setOtherOpen(false);
    onChange(choice === 'once' ? null : defaultRecurrence(choice === 'weekly' ? 'weekly' : choice === 'monthly' ? 'monthly' : 'yearly', startDate));
  }

  function toggleWeekday(day: Weekday): void {
    if (value?.freq !== 'weekly') return;
    const has = value.weekdays.includes(day);
    if (has && value.weekdays.length === 1) return; // au moins un jour (T-09 : jours cochés non vides)
    const weekdays = (has ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day]).sort((a, b) => a - b);
    onChange({ ...value, weekdays });
  }

  function pickDaysMode(): void {
    if (startDate === null) return;
    setDaysDraft('2');
    onChange({ ...defaultRecurrence('daily', startDate), interval: 2 });
  }

  function pickNthMode(): void {
    if (startDate === null) return;
    const { day } = parseLocalDate(startDate);
    onChange({
      ...defaultRecurrence('monthly', startDate),
      monthDay: null,
      nthWeekday: { nth: Math.min(4, Math.ceil(day / 7)) as 1 | 2 | 3 | 4, weekday: weekdayOf(startDate) },
    });
  }

  function changeDays(text: string): void {
    setDaysDraft(text);
    const n = Number(text);
    if (value?.freq === 'daily' && Number.isInteger(n) && n >= 2) onChange({ ...value, interval: n });
  }

  const dailyMode = value?.freq === 'daily';
  const nthMode = value?.freq === 'monthly' && value.nthWeekday !== null;

  return (
    <div className={['ct-recurrence', className].filter(Boolean).join(' ')}>
      <span className="ct-recurrence__label" id={labelId}>
        {t('tasks.repeatLabel')}
      </span>
      <div className="ct-recurrence__choices" role="radiogroup" aria-labelledby={labelId}>
        {CHOICES.map((choice) => {
          const checked = current === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled && choice.id !== 'once'}
              className="ct-recurrence__radio"
              onClick={() => choose(choice.id)}
            >
              <span className="ct-recurrence__dot" aria-hidden="true">
                {checked && <span className="ct-recurrence__dotFill" />}
              </span>
              {t(choice.labelKey)}
            </button>
          );
        })}
      </div>

      {disabled && <p className="ct-recurrence__hint">{t('tasks.repeatNeedsDate')}</p>}

      {value?.freq === 'weekly' && (
        <div className="ct-recurrence__weekdays" role="group" aria-label={t('tasks.repeatWeekdaysLabel')}>
          {WEEKDAYS.map((day) => {
            const key = WEEKDAY_KEYS[day - 1] as (typeof WEEKDAY_KEYS)[number];
            return (
              <button
                key={day}
                type="button"
                aria-pressed={value.weekdays.includes(day)}
                aria-label={t(`recurrence.weekdayLong.${key}`)}
                className="ct-recurrence__weekday"
                onClick={() => toggleWeekday(day)}
              >
                {t(`tasks.repeatWeekdayLetter.${key}`)}
              </button>
            );
          })}
        </div>
      )}

      {!disabled && (
        <button
          type="button"
          className="ct-recurrence__other"
          aria-expanded={showOther}
          onClick={() => setOtherOpen((open) => !open)}
        >
          {t('tasks.repeatOther')}
        </button>
      )}

      {!disabled && showOther && (
        <div className="ct-recurrence__panel" role="radiogroup" aria-label={t('tasks.repeatOtherGroup')}>
          <div className="ct-recurrence__panelRow">
            <button type="button" role="radio" aria-checked={dailyMode} className="ct-recurrence__radio" onClick={pickDaysMode}>
              <span className="ct-recurrence__dot" aria-hidden="true">
                {dailyMode && <span className="ct-recurrence__dotFill" />}
              </span>
              {t('tasks.repeatModeDays')}
            </button>
            {dailyMode && (
              <input
                type="number"
                min={2}
                step={1}
                inputMode="numeric"
                aria-label={t('tasks.repeatDaysCount')}
                className="ct-recurrence__control ct-recurrence__number"
                value={daysDraft === '' ? String(value?.interval ?? 2) : daysDraft}
                onChange={(event) => changeDays(event.target.value)}
              />
            )}
          </div>
          <div className="ct-recurrence__panelRow">
            <button type="button" role="radio" aria-checked={nthMode} className="ct-recurrence__radio" onClick={pickNthMode}>
              <span className="ct-recurrence__dot" aria-hidden="true">
                {nthMode && <span className="ct-recurrence__dotFill" />}
              </span>
              {t('tasks.repeatModeNth')}
            </button>
            {value?.nthWeekday && (
              <>
                <select
                  aria-label={t('tasks.repeatNthLabel')}
                  className="ct-recurrence__control"
                  value={value.nthWeekday.nth}
                  onChange={(event) =>
                    onChange({ ...value, nthWeekday: { weekday: value.nthWeekday?.weekday ?? 1, nth: Number(event.target.value) as 1 | 2 | 3 | 4 | -1 } })
                  }
                >
                  {NTH_VALUES.map((nth) => (
                    <option key={nth} value={nth}>
                      {nth === -1 ? t('tasks.repeatLast') : t(`recurrence.ordinal.${ORDINAL_KEYS[nth - 1] as (typeof ORDINAL_KEYS)[number]}`)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('tasks.repeatWeekdayLabel')}
                  className="ct-recurrence__control"
                  value={value.nthWeekday.weekday}
                  onChange={(event) =>
                    onChange({ ...value, nthWeekday: { nth: value.nthWeekday?.nth ?? 1, weekday: Number(event.target.value) as Weekday } })
                  }
                >
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {t(`recurrence.weekdayLong.${WEEKDAY_KEYS[day - 1] as (typeof WEEKDAY_KEYS)[number]}`)}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}

      {custom && value && (
        <p className="ct-recurrence__summary" data-testid="recurrence-summary">
          {formatMessageRef(recurrenceLabel(value, startDate))}
        </p>
      )}
    </div>
  );
}
