import { useState } from 'react';
import { parseTimeInput } from '../../domain/dateInput';
import type { LocalTime } from '../../domain/types';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { TimeWheelColumns, type Layout } from '../../ui';
import './RoutineTimeEditor.css';

export interface RoutineTimeEditorProps {
  /** Heure de la routine, null : sans heure. */
  readonly value: LocalTime | null;
  readonly onChange: (time: LocalTime | null) => void;
  readonly layout: Layout;
}


/**
 * Sélecteur d'heure d'une routine (R-02 critère 1), 24 h : roues Heures + Minutes sur iPhone (« — » = sans heure, comme les roues de
 * T-14), champ HH:MM au clavier sur PC (« 7h30 », « 07:30 », « 0730 » ; vide ou « Effacer » : sans heure).
 */
export function RoutineTimeEditor({ value, onChange, layout }: RoutineTimeEditorProps) {
  return layout === 'mobile' ? <TimeWheels value={value} onChange={onChange} /> : <TimeInput value={value} onChange={onChange} />;
}

function TimeInput({ value, onChange }: Pick<RoutineTimeEditorProps, 'value' | 'onChange'>) {
  const [text, setText] = useState(value ? formatTime(value) : '');
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
        maxLength={8}
        className="ct-routine-time__input"
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => {
          // Saisie valide : l'heure est écrite dans le format choisi (« 7h30 » devient « 07:30 » ou « 7:30 AM »).
          const parsed = parseTimeInput(text);
          if (parsed.ok) setText(parsed.value ? formatTime(parsed.value) : '');
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
  return (
    <div className="ct-routine-time ct-routine-time--wheels" role="group" aria-label={t('routines.form.timeWheelsLabel')}>
      <TimeWheelColumns value={value} onChange={onChange} hourClassName="ct-routine-time__wheel" minuteClassName="ct-routine-time__wheel" meridiemClassName="ct-routine-time__wheel" />
    </div>
  );
}
