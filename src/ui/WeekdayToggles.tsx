import { weekdayName } from '../i18n/formatRoutine';
import type { Weekday } from '../domain/types';
import './WeekdayToggles.css';

const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

export interface WeekdayTogglesProps {
  /** Jours cochés (1 = lundi … 7 = dimanche). */
  value: readonly Weekday[];
  onToggle: (day: Weekday) => void;
  /** Libellé du groupe (clé i18n résolue par l'appelant). */
  label: string;
  className?: string;
}

/**
 * Pastilles de jours L à D (ModifierRoutine.html) : cases à cocher rondes nommées par le jour complet (« Lundi »). Partagées par le
 * formulaire de routine (R-01) et l'éditeur de plages silencieuses (ES-07).
 */
export function WeekdayToggles({ value, onToggle, label, className }: WeekdayTogglesProps) {
  return (
    <div role="group" aria-label={label} className={['ct-weekday-toggles', className].filter(Boolean).join(' ')}>
      {WEEK.map((day) => (
        <button
          key={day}
          type="button"
          role="checkbox"
          aria-checked={value.includes(day)}
          aria-label={weekdayName(day, 'long').replace(/^./, (c) => c.toUpperCase())}
          className="ct-weekday-toggles__day"
          onClick={() => onToggle(day)}
        >
          {weekdayName(day, 'long').charAt(0).toUpperCase()}
        </button>
      ))}
    </div>
  );
}
