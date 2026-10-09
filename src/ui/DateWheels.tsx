import { useMemo } from 'react';
import { addDays } from '../domain/localDate';
import type { DateChoice } from '../domain/dateInput';
import { WHEEL_DAYS_BEFORE, wheelDayIndex, wheelDays } from '../domain/wheelChoices';
import type { LocalDate } from '../domain/types';
import { t } from '../i18n';
import { formatWheelDay } from '../i18n/format';
import { TimeWheelColumns } from './TimeWheelColumns';
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
  /** « Un jour » indisponible (tâche récurrente, QB-11) : puce grisée (`aria-disabled`), sans effet, avec cette aide. */
  somedayDisabledHint?: string;
  /** Montre les roues heures et minutes (défaut : oui) ; sans elles, seule la date est choisie (report). */
  showTime?: boolean;
  className?: string;
}

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
export function DateWheels({ value, today, onChange, allowSomeday = true, somedayDisabledHint, showTime = true, className }: DateWheelsProps) {
  const days = useMemo(() => wheelDays(today), [today]);
  // Libellés calculés à la lecture : la roue des jours compte 791 éléments, mais seuls ceux rendus sont formatés (Q-05, ouverture de la feuille).
  const dayItems = useMemo<WheelItem[]>(
    () =>
      days.map((day) => ({
        get label(): string {
          return day === today ? t('datePicker.today') : formatWheelDay(day);
        },
      })),
    [days, today],
  );

  const someday = value.date === null;
  const dayIndex = value.date === null ? WHEEL_DAYS_BEFORE : wheelDayIndex(today, value.date);
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
            <button
              type="button"
              className="ct-date-wheels__chip"
              aria-pressed={someday}
              {...(somedayDisabledHint ? { 'aria-disabled': true, 'aria-describedby': 'ct-date-wheels-somedayHint' } : {})}
              onClick={() => {
                if (!somedayDisabledHint) setSomeday();
              }}
            >
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
          <TimeWheelColumns
            value={value.time}
            disabled={someday}
            onChange={(time) => onChange({ date: value.date, time })}
            hourClassName="ct-date-wheels__hour"
            minuteClassName="ct-date-wheels__minute"
            meridiemClassName="ct-date-wheels__minute"
          />
        )}
      </div>
      {allowSomeday && somedayDisabledHint && (
        <p id="ct-date-wheels-somedayHint" className="ct-date-wheels__hint">
          {somedayDisabledHint}
        </p>
      )}
      {someday && <p className="ct-date-wheels__hint">{t('datePicker.somedayHint')}</p>}
    </div>
  );
}

