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
  /** Date proposée à l'ouverture ; null : « Un jour » présélectionné (avec `allowSomeday`, T-12 / Q8). */
  initialValue: LocalDate | null;
  /** Propose « Un jour » (sans date) à côté du champ ; `onConfirm(null)` quand il est validé (T-12). */
  allowSomeday?: boolean;
  /** Date valide choisie (null : « Un jour ») ; Échap / « Fermer » n'appellent que `onClose`. */
  onConfirm: (date: LocalDate | null) => void;
  onClose: () => void;
}

/**
 * Choix d'une date (T-05, « Choisir une date »). Version minimale : champ de date
 * natif, en attendant le sélecteur adapté à l'appareil de T-14 (roues iPhone,
 * mini-calendrier PC) qui le remplacera sans changer ce contrat. Feuille sur
 * iPhone, fenêtre centrée sur PC.
 */
export function DatePrompt({ open, label, confirmLabel, initialValue, allowSomeday = false, onConfirm, onClose }: DatePromptProps) {
  const layout = useLayout();
  if (!open) return null;
  const form = <DatePromptForm label={label} confirmLabel={confirmLabel} initialValue={initialValue} allowSomeday={allowSomeday} onConfirm={onConfirm} onClose={onClose} />;
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

function DatePromptForm({ label, confirmLabel, initialValue, allowSomeday = false, onConfirm, onClose }: Omit<DatePromptProps, 'open'>) {
  const [value, setValue] = useState<string>(initialValue ?? '');
  // « Un jour » : choisi à l'ouverture si l'original l'est, ou par le bouton ; modifier la date le lève.
  const [someday, setSomeday] = useState(allowSomeday && initialValue === null);
  const valid = someday || isLocalDate(value);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (someday) onConfirm(null);
    else if (isLocalDate(value)) onConfirm(value);
  }

  return (
    <form className="ct-date-prompt" onSubmit={handleSubmit}>
      <h2 className="ct-date-prompt__heading">{label}</h2>
      <input
        type="date"
        aria-label={t('tasks.postponeDateLabel')}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setSomeday(false);
        }}
        className="ct-date-prompt__input"
      />
      {allowSomeday && (
        <Button variant="secondary" fullWidth pressed={someday} onClick={() => setSomeday(true)}>
          {t('tasks.someday')}
        </Button>
      )}
      <Button type="submit" fullWidth disabled={!valid}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" fullWidth onClick={onClose}>
        {t('common.close')}
      </Button>
    </form>
  );
}
