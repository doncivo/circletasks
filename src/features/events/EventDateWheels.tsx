import { useMemo } from 'react';
import { clampedDay } from '../../domain/eventOccurrences';
import { daysInMonth, makeLocalDate, parseLocalDate } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { WheelPicker, type WheelItem } from '../../ui';
import './EventDateWheels.css';

export interface EventDateWheelsProps {
  value: LocalDate;
  onChange: (date: LocalDate) => void;
  /** Années proposées (bornes incluses) ; l'année de `value` est toujours ajoutée si elle sort de la plage. */
  years: { readonly from: number; readonly to: number };
  /**
   * Année facultative (E-02) : une position « Sans année » ouvre la roue des années. `value` porte alors l'année de repli et
   * `yearValue` l'année choisie (null : sans année) ; sinon la roue ne propose que des années.
   */
  yearValue?: number | null;
  onYearChange?: (year: number | null) => void;
  /** Libellé de la position « Sans année ». */
  noYearLabel?: string;
}

function monthNames(): string[] {
  const format = new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => format.format(new Date(Date.UTC(2024, i, 1))));
}

/**
 * Roues jour / mois / année de la feuille « Nouvel événement » (AjoutEvenement.html). Changer le mois ou l'année garde le quantième
 * quand il existe, sinon le ramène au dernier jour du mois (le 31 devient le 30 ou le 28). Avec `yearValue`, la roue des années
 * commence par « Sans année » (E-02 critère 3).
 */
export function EventDateWheels({ value, onChange, years, yearValue, onYearChange, noYearLabel }: EventDateWheelsProps) {
  const { year, month, day } = parseLocalDate(value);
  const optionalYear = onYearChange !== undefined;
  const shownYear = optionalYear ? (yearValue ?? null) : year;
  const lo = Math.min(years.from, shownYear ?? years.from);
  const hi = Math.max(years.to, shownYear ?? years.to);

  const months = useMemo(() => monthNames().map((label): WheelItem => ({ label })), []);
  const dayItems = useMemo(
    () => Array.from({ length: daysInMonth(year, month) }, (_, i): WheelItem => ({ label: String(i + 1) })),
    [year, month],
  );
  const yearItems = useMemo(() => {
    const items: WheelItem[] = optionalYear ? [{ label: noYearLabel ?? '—' }] : [];
    for (let y = lo; y <= hi; y += 1) items.push({ label: String(y) });
    return items;
  }, [lo, hi, optionalYear, noYearLabel]);
  const yearIndex = shownYear === null ? 0 : shownYear - lo + (optionalYear ? 1 : 0);

  const change = (nextYear: number, nextMonth: number, nextDay: number): void => onChange(clampedDay(nextYear, nextMonth, nextDay));

  return (
    <div className="ct-event-wheels">
      <WheelPicker label={t('events.sheet.wheelDay')} items={dayItems} index={day - 1} onChange={(i) => onChange(makeLocalDate(year, month, i + 1))} pageStep={7} />
      <WheelPicker label={t('events.sheet.wheelMonth')} items={months} index={month - 1} onChange={(i) => change(year, i + 1, day)} pageStep={3} />
      <WheelPicker
        label={t('events.sheet.wheelYear')}
        items={yearItems}
        index={yearIndex}
        pageStep={5}
        onChange={(i) => {
          if (optionalYear) {
            const picked = i === 0 ? null : lo + i - 1;
            onYearChange?.(picked);
            if (picked !== null) change(picked, month, day);
          } else {
            change(lo + i, month, day);
          }
        }}
      />
    </div>
  );
}
