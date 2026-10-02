import { useState, type FormEvent, type ReactNode } from 'react';
import { isLocalDate, type LocalDate } from '../domain/types';
import { t } from '../i18n';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { useFocusTrap } from './useFocusTrap';
import { useLayout } from './useLayout';
import './DatePrompt.css';

export interface DatePromptProps {
  open: boolean;
  /** Titre et nom accessible (ex. « Choisir une date »). */
  label: string;
  /** Libellé du bouton de validation (ex. « Valider »). */
  confirmLabel: string;
  /** Date proposée à l'ouverture. */
  initialValue: LocalDate;
  /** Date valide choisie ; Échap / « Fermer » n'appellent que `onClose`. */
  onConfirm: (date: LocalDate) => void;
  onClose: () => void;
}

/**
 * Choix d'une date (T-05, « Choisir une date »). Version minimale : champ de date
 * natif, en attendant le sélecteur adapté à l'appareil de T-14 (roues iPhone,
 * mini-calendrier PC) qui le remplacera sans changer ce contrat. Feuille sur
 * iPhone, fenêtre centrée sur PC.
 */
export function DatePrompt({ open, label, confirmLabel, initialValue, onConfirm, onClose }: DatePromptProps) {
  const layout = useLayout();
  if (!open) return null;
  const form = <DatePromptForm label={label} confirmLabel={confirmLabel} initialValue={initialValue} onConfirm={onConfirm} onClose={onClose} />;
  if (layout === 'mobile') {
    return (
      <Sheet open onClose={onClose} label={label}>
        {form}
      </Sheet>
    );
  }
  return (
    <DatePromptModal label={label} onClose={onClose}>
      {form}
    </DatePromptModal>
  );
}

function DatePromptModal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });
  return (
    <div className="ct-date-prompt__backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="ct-date-prompt__modal">
        {children}
      </div>
    </div>
  );
}

function DatePromptForm({ label, confirmLabel, initialValue, onConfirm, onClose }: Omit<DatePromptProps, 'open'>) {
  const [value, setValue] = useState<string>(initialValue);
  const valid = isLocalDate(value);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (isLocalDate(value)) onConfirm(value);
  }

  return (
    <form className="ct-date-prompt" onSubmit={handleSubmit}>
      <h2 className="ct-date-prompt__heading">{label}</h2>
      <input
        type="date"
        aria-label={t('tasks.postponeDateLabel')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="ct-date-prompt__input"
      />
      <Button type="submit" fullWidth disabled={!valid}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" fullWidth onClick={onClose}>
        {t('common.close')}
      </Button>
    </form>
  );
}
