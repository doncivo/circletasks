import { useMemo, useState } from 'react';
import { parseTimeInput } from '../../domain/dateInput';
import { WHEEL_HOURS, WHEEL_MINUTES, timeToWheel, wheelToTime } from '../../domain/wheelChoices';
import type { LocalTime } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { WheelPicker, type WheelItem, type Layout } from '../../ui';
import './RoutineTimeEditor.css';

export interface RoutineTimeEditorProps {
  /** Heure de la routine, null : sans heure. */
  readonly value: LocalTime | null;
  readonly onChange: (time: LocalTime | null) => void;
  readonly layout: Layout;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const plural = (n: number): Intl.LDMLPluralRule => new Intl.PluralRules(getLocale()).select(n);

/**
 * Sélecteur d'heure d'une routine (R-02 critère 1), 24 h : roues Heures + Minutes sur iPhone (« — » = sans heure, comme les roues de
 * T-14), champ HH:MM au clavier sur PC (« 7h30 », « 07:30 », « 0730 » ; vide ou « Effacer » : sans heure).
 */
export function RoutineTimeEditor({ value, onChange, layout }: RoutineTimeEditorProps) {
  return layout === 'mobile' ? <TimeWheels value={value} onChange={onChange} /> : <TimeInput value={value} onChange={onChange} />;
}

function TimeInput({ value, onChange }: Pick<RoutineTimeEditorProps, 'value' | 'onChange'>) {
  const [text, setText] = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);

  function handleChange(next: string): void {
    setText(next);
    const parsed = parseTimeInput(next);
    setInvalid(!parsed.ok);
    if (parsed.ok) onChange(parsed.value);
  }

  return (
    <div className="ct-routine-time">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={t('routines.form.timeInputLabel')}
        aria-invalid={invalid}
        placeholder={t('routines.form.timePlaceholder')}
        value={text}
        maxLength={5}
        className="ct-routine-time__input"
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => {
          // Saisie valide : l'heure est écrite au format 24 h (« 7h30 » devient « 07:30 »).
          const parsed = parseTimeInput(text);
          if (parsed.ok) setText(parsed.value ?? '');
        }}
      />
      <button
        type="button"
        className="ct-routine-time__clear"
        disabled={value === null && text === ''}
        onClick={() => {
          setText('');
          setInvalid(false);
          onChange(null);
        }}
      >
        {t('routines.form.timeClear')}
      </button>
      {invalid && (
        <span className="ct-routine-time__error" role="alert">
          {t('datePicker.timeNotUnderstood')}
        </span>
      )}
    </div>
  );
}

function TimeWheels({ value, onChange }: Pick<RoutineTimeEditorProps, 'value' | 'onChange'>) {
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
  const wheel = timeToWheel(value);
  // Minutes mémorisées quand on repasse sur « — » puis qu'on rechoisit une heure.
  const [rememberedMinute, setRememberedMinute] = useState(wheel?.minute ?? 0);
  const minute = wheel?.minute ?? rememberedMinute;

  return (
    <div className="ct-routine-time ct-routine-time--wheels" role="group" aria-label={t('routines.form.timeWheelsLabel')}>
      <WheelPicker
        label={t('datePicker.wheelHour')}
        items={hourItems}
        index={wheel === null ? 0 : wheel.hour + 1}
        pageStep={6}
        onChange={(i) => onChange(wheelToTime(i === 0 ? null : i - 1, minute))}
        className="ct-routine-time__wheel"
      />
      <WheelPicker
        label={t('datePicker.wheelMinute')}
        items={minuteItems}
        index={Math.max(WHEEL_MINUTES.indexOf(minute), 0)}
        disabled={wheel === null}
        pageStep={3}
        onChange={(i) => {
          const next = WHEEL_MINUTES[i] ?? 0;
          setRememberedMinute(next);
          onChange(wheelToTime(wheel === null ? null : wheel.hour, next));
        }}
        className="ct-routine-time__wheel"
      />
    </div>
  );
}
