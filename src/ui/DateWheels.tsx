import { useMemo, useState } from 'react';
import { addDays } from '../domain/localDate';
import type { DateChoice } from '../domain/dateInput';
import {
  WHEEL_DAYS_BEFORE,
  WHEEL_HOURS,
  WHEEL_MINUTES,
  timeToWheel,
  wheelDayIndex,
  wheelDays,
  wheelToTime,
} from '../domain/wheelChoices';
import type { LocalDate } from '../domain/types';
import { getLocale, t } from '../i18n';
import { formatWheelDay } from '../i18n/format';
import { WheelPicker, type WheelItem } from './WheelPicker';
import './DateWheels.css';

export interface DateWheelsProps {
  /** Choix courant ; `date` null = « Un jour ». */
  value: DateChoice;
  /** Aujourd'hui, fourni par l'appelant (horloge du conteneur). */
  today: LocalDate;
  onChange: (choice: DateChoice) => void;
  /** Propose la puce « Un jour » (défaut : oui). */
  allowSomeday?: boolean;
  /** Montre les roues heures et minutes (défaut : oui) ; sans elles, seule la date est choisie (report). */
  showTime?: boolean;
  className?: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Catégorie de pluriel de la langue courante (français : 0 et 1 au singulier), pour les valeurs annoncées. */
const plural = (n: number): Intl.LDMLPluralRule => new Intl.PluralRules(getLocale()).select(n);

/**
 * Sélecteur de date iPhone (T-14, Ajout.html) : puces « Aujourd'hui » / « Demain » / « Un jour » et trois roues
 * (jours, heures, minutes par pas de 5). La roue des jours part de « Aujourd'hui » et propose jours passés et
 * futurs (« Jeu. 24 sept. ») ; la roue des heures commence par « — » (sans heure, Q9), ses minutes sont alors
 * grisées ; « Un jour » grise les trois roues (tâche sans date ni heure). Les trois roues restent toujours
 * affichées (pas d'interrupteur « Heure »).
 *
 * @example
 * <DateWheels value={choice} today={today} onChange={setChoice} />
 */
export function DateWheels({ value, today, onChange, allowSomeday = true, showTime = true, className }: DateWheelsProps) {
  const days = useMemo(() => wheelDays(today), [today]);
  const dayItems = useMemo<WheelItem[]>(
    () => days.map((day) => ({ label: day === today ? t('datePicker.today') : formatWheelDay(day) })),
    [days, today],
  );
  const hourItems = useMemo<WheelItem[]>(
    () => [
      { label: t('datePicker.noHour'), spoken: t('datePicker.noHourSpoken') },
      ...WHEEL_HOURS.map((hour) => ({ label: pad2(hour), spoken: t(plural(hour) === 'one' ? 'datePicker.hourSpokenOne' : 'datePicker.hourSpoken', { hour }) })),
    ],
    [],
  );
  const minuteItems = useMemo<WheelItem[]>(
    () => WHEEL_MINUTES.map((minute) => ({ label: pad2(minute), spoken: t(plural(minute) === 'one' ? 'datePicker.minuteSpokenOne' : 'datePicker.minuteSpoken', { minute }) })),
    [],
  );

  const someday = value.date === null;
  const wheel = timeToWheel(value.time);
  // Minutes mémorisées quand on repasse sur « — » puis qu'on rechoisit une heure.
  const [rememberedMinute, setRememberedMinute] = useState(wheel?.minute ?? 0);
  const minute = wheel?.minute ?? rememberedMinute;
  const dayIndex = value.date === null ? WHEEL_DAYS_BEFORE : wheelDayIndex(today, value.date);
  const hourIndex = wheel === null ? 0 : wheel.hour + 1;
  const minuteIndex = Math.max(WHEEL_MINUTES.indexOf(minute), 0);
  const tomorrow = addDays(today, 1);

  function setDate(date: LocalDate): void {
    onChange({ date, time: value.time });
  }
  function setSomeday(): void {
    onChange({ date: null, time: null });
  }
  function pickChip(date: LocalDate): void {
    onChange({ date, time: value.time });
  }

  return (
    <div className={['ct-date-wheels', className].filter(Boolean).join(' ')} role="group" aria-label={t('datePicker.wheelsLabel')}>
      <div className="ct-date-wheels__chips">
        <span className="ct-date-wheels__label">{t('datePicker.dateLabel')}</span>
        <div className="ct-date-wheels__chipRow">
          <button type="button" className="ct-date-wheels__chip" aria-pressed={value.date === today} onClick={() => pickChip(today)}>
            {t('datePicker.today')}
          </button>
          <button type="button" className="ct-date-wheels__chip" aria-pressed={value.date === tomorrow} onClick={() => pickChip(tomorrow)}>
            {t('datePicker.tomorrow')}
          </button>
          {allowSomeday && (
            <button type="button" className="ct-date-wheels__chip" aria-pressed={someday} onClick={setSomeday}>
              {t('datePicker.someday')}
            </button>
          )}
        </div>
      </div>
      <div className="ct-date-wheels__wheels">
        <WheelPicker
          label={t('datePicker.wheelDay')}
          items={dayItems}
          index={dayIndex}
          disabled={someday}
          pageStep={7}
          onChange={(i) => {
            const day = days[i];
            if (day) setDate(day);
          }}
          className="ct-date-wheels__day"
        />
        {showTime && (
          <>
            <WheelPicker
              label={t('datePicker.wheelHour')}
              items={hourItems}
              index={hourIndex}
              disabled={someday}
              pageStep={6}
              onChange={(i) => onChange({ date: value.date, time: wheelToTime(i === 0 ? null : i - 1, minute) })}
              className="ct-date-wheels__hour"
            />
            <WheelPicker
              label={t('datePicker.wheelMinute')}
              items={minuteItems}
              index={minuteIndex}
              disabled={someday || wheel === null}
              pageStep={3}
              onChange={(i) => {
                const next = WHEEL_MINUTES[i] ?? 0;
                setRememberedMinute(next);
                onChange({ date: value.date, time: wheelToTime(wheel === null ? null : wheel.hour, next) });
              }}
              className="ct-date-wheels__minute"
            />
          </>
        )}
      </div>
      {someday && <p className="ct-date-wheels__hint">{t('datePicker.somedayHint')}</p>}
    </div>
  );
}

