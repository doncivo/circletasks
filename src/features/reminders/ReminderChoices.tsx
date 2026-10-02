import { Check } from 'lucide-react';
import { useState } from 'react';
import { REMINDER_OFFSETS_MIN, type ReminderOffsetMin } from '../../domain/model';
import { REMINDER_QUICK_OFFSETS } from '../../domain/reminders';
import { tDynamic } from '../../i18n';
import './ReminderChoices.css';

/** Libellé court d'une avance (cases de saisie) : « À l'heure », « 5 min », « 1 heure », « 1 jour ». */
export const reminderChoiceLabel = (offset: ReminderOffsetMin): string => tDynamic(`reminders.choice${String(offset)}` as 'reminders.choice0');

export interface ReminderChoicesProps {
  /** Avances cochées. */
  readonly offsets: readonly ReminderOffsetMin[];
  /** Faux sans heure (QB-07) : cases grisées, non cochables, affichées décochées. */
  readonly enabled: boolean;
  readonly onToggle: (offset: ReminderOffsetMin) => void;
  /** Avances montrées d'emblée ; les autres sont sous « Plus… » (Ajout.html : À l'heure, 30 min, 1 heure). */
  readonly quick?: readonly ReminderOffsetMin[];
  readonly plusLabel: string;
}

/**
 * Cases d'avance d'un rappel (N-02, Ajout.html, ModifierRoutine.html) : les rappels rapides, puis « Plus… » qui montre les six avances.
 * Fragment : s'insère dans la rangée de l'appelant (qui fournit le retour à la ligne). Chaque avance est cochable indépendamment.
 */
export function ReminderChoices({ offsets, enabled, onToggle, quick = REMINDER_QUICK_OFFSETS, plusLabel }: ReminderChoicesProps) {
  // Une avance posée ailleurs (hors rappels rapides) reste visible : la liste est dépliée d'office.
  const [expanded, setExpanded] = useState(() => offsets.some((offset) => !quick.includes(offset)));
  const shown = expanded ? REMINDER_OFFSETS_MIN : quick;
  return (
    <>
      {shown.map((offset) => {
        const checked = enabled && offsets.includes(offset);
        return (
          <button
            key={offset}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-disabled={!enabled}
            className="ct-reminder"
            onClick={() => {
              if (enabled) onToggle(offset);
            }}
          >
            <span className="ct-reminder__box" data-checked={checked}>
              {checked && <Check size={14} strokeWidth={3.4} aria-hidden="true" />}
            </span>
            {reminderChoiceLabel(offset)}
          </button>
        );
      })}
      {!expanded && (
        <button type="button" className="ct-reminder ct-reminder--more" aria-expanded={false} onClick={() => setExpanded(true)}>
          {plusLabel}
        </button>
      )}
    </>
  );
}
