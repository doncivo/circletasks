import { useMemo, useState } from 'react';
import { WHEEL_HOURS, WHEEL_MINUTES, timeToWheel, wheelToTime } from '../domain/wheelChoices';
import { hour12To24, hourColumnLabel } from '../domain/timeFormat';
import type { LocalTime } from '../domain/types';
import { getLocale, t } from '../i18n';
import { getTimeFormat } from '../i18n/formatPrefs';
import { WheelPicker, type WheelItem } from './WheelPicker';

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Catégorie de pluriel de la langue courante (français : 0 et 1 au singulier), pour les valeurs annoncées. */
const plural = (n: number): Intl.LDMLPluralRule => new Intl.PluralRules(getLocale()).select(n);

export interface TimeWheelColumnsProps {
  readonly value: LocalTime | null;
  readonly onChange: (time: LocalTime | null) => void;
  /** Grise les trois colonnes (« Un jour »). */
  readonly disabled?: boolean;
  readonly hourClassName?: string;
  readonly minuteClassName?: string;
  readonly meridiemClassName?: string;
}

/**
 * Colonnes d'heure des roues iPhone (T-14, P-03) : heures « — » puis 00 à 23 en 24 h ; en 12 h, 12, 1 à 11 suivies d'une colonne
 * AM / PM. Minutes par pas de 5. La valeur émise reste 'HH:mm' (24 h) quel que soit l'affichage.
 */
export function TimeWheelColumns({ value, onChange, disabled = false, hourClassName = '', minuteClassName = '', meridiemClassName = '' }: TimeWheelColumnsProps) {
  const format = getTimeFormat();
  const hourItems = useMemo<WheelItem[]>(() => {
    const hours = format === '24h' ? WHEEL_HOURS : WHEEL_HOURS.slice(0, 12);
    return [
      { label: t('datePicker.noHour'), spoken: t('datePicker.noHourSpoken') },
      ...hours.map((hour) => ({
        label: hourColumnLabel(hour, format),
        spoken: t(plural(hour) === 'one' ? 'datePicker.hourSpokenOne' : 'datePicker.hourSpoken', { hour: format === '24h' ? hour : hour === 0 ? 12 : hour }),
      })),
    ];
  }, [format]);
  const minuteItems = useMemo<WheelItem[]>(
    () => WHEEL_MINUTES.map((minute) => ({ label: pad2(minute), spoken: t(plural(minute) === 'one' ? 'datePicker.minuteSpokenOne' : 'datePicker.minuteSpoken', { minute }) })),
    [],
  );
  const meridiemItems = useMemo<WheelItem[]>(() => [{ label: 'AM' }, { label: 'PM' }], []);

  const wheel = timeToWheel(value);
  // Minutes (et AM / PM) mémorisées quand on repasse sur « — » puis qu'on rechoisit une heure.
  const [rememberedMinute, setRememberedMinute] = useState(wheel?.minute ?? 0);
  const [rememberedPm, setRememberedPm] = useState(wheel !== null && wheel.hour >= 12);
  const minute = wheel?.minute ?? rememberedMinute;
  const pm = wheel === null ? rememberedPm : wheel.hour >= 12;
  const hourIndex = wheel === null ? 0 : (format === '24h' ? wheel.hour : wheel.hour % 12) + 1;

  return (
    <>
      <WheelPicker
        label={t('datePicker.wheelHour')}
        items={hourItems}
        index={hourIndex}
        disabled={disabled}
        pageStep={6}
        onChange={(i) => {
          if (i === 0) return onChange(wheelToTime(null, minute));
          onChange(wheelToTime(format === '24h' ? i - 1 : hour12To24(i - 1, pm), minute));
        }}
        className={hourClassName}
      />
      <WheelPicker
        label={t('datePicker.wheelMinute')}
        items={minuteItems}
        index={Math.max(WHEEL_MINUTES.indexOf(minute), 0)}
        disabled={disabled || wheel === null}
        pageStep={3}
        onChange={(i) => {
          const next = WHEEL_MINUTES[i] ?? 0;
          setRememberedMinute(next);
          onChange(wheelToTime(wheel === null ? null : wheel.hour, next));
        }}
        className={minuteClassName}
      />
      {format === '12h' && (
        <WheelPicker
          label={t('datePicker.wheelMeridiem')}
          items={meridiemItems}
          index={pm ? 1 : 0}
          disabled={disabled || wheel === null}
          pageStep={1}
          onChange={(i) => {
            setRememberedPm(i === 1);
            if (wheel !== null) onChange(wheelToTime(hour12To24(wheel.hour, i === 1), wheel.minute));
          }}
          className={meridiemClassName}
        />
      )}
    </>
  );
}
