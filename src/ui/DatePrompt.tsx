import { useState, type FormEvent, type ReactNode } from 'react';
import type { DateChoice } from '../domain/dateInput';
import type { LocalDate, LocalTime } from '../domain/types';
import { t } from '../i18n';
import { Button } from './Button';
import { DateEditor } from './DateField';
import { DateWheels } from './DateWheels';
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
  /** Aujourd'hui, fourni par l'appelant (horloge du conteneur). */
  today: LocalDate;
  /** Date proposée à l'ouverture ; null : « Un jour » présélectionné (avec `allowSomeday`, T-12 / Q8). */
  initialValue: LocalDate | null;
  /** Heure proposée à l'ouverture (avec `showTime`). */
  initialTime?: LocalTime | null;
  /** Propose « Un jour » (sans date) ; `onConfirm(null, null)` quand il est validé (T-12, SD-02). */
  allowSomeday?: boolean;
  /** Choisit aussi une heure (défaut : non ; le report conserve l'heure de la tâche). */
  showTime?: boolean;
  /** Date et heure valides choisies (date null : « Un jour ») ; Échap / « Fermer » n'appellent que `onClose`. */
  onConfirm: (date: LocalDate | null, time: LocalTime | null) => void;
  onClose: () => void;
}

/**
 * Fenêtre « Choisir une date » (T-05, T-12, SD-02) avec le sélecteur de date adapté à l'appareil (T-14) :
 * sur iPhone, une feuille avec puces et roues ; sur PC, une fenêtre centrée avec champ à saisie libre
 * (« demain », « lun. 10h »), puces « Aujourd'hui / Demain / Lundi prochain / Un jour » et mini-calendrier.
 * Entrée ou le bouton de validation applique, Échap ou « Fermer » ne change rien.
 */
export function DatePrompt({ open, ...props }: DatePromptProps) {
  const layout = useLayout();
  if (!open) return null;
  const form = <DatePromptForm layout={layout} {...props} />;
  if (layout === 'mobile') {
    return (
      <Sheet open onClose={props.onClose} label={props.label}>
        {form}
      </Sheet>
    );
  }
  return (
    <DatePromptModal label={props.label} onClose={props.onClose}>
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

function DatePromptForm({
  layout,
  label,
  confirmLabel,
  today,
  initialValue,
  initialTime = null,
  allowSomeday = false,
  showTime = false,
  onConfirm,
  onClose,
}: Omit<DatePromptProps, 'open'> & { layout: 'pc' | 'mobile' }) {
  const startChoice: DateChoice =
    initialValue === null && allowSomeday ? { date: null, time: null } : { date: initialValue ?? today, time: showTime ? initialTime : null };
  const [choice, setChoice] = useState<DateChoice | null>(startChoice);

  function confirm(next: DateChoice | null): void {
    if (next) onConfirm(next.date, next.date === null ? null : showTime ? next.time : null);
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    confirm(choice);
  }

  return (
    <form className="ct-date-prompt" onSubmit={handleSubmit}>
      <h2 className="ct-date-prompt__heading">{label}</h2>
      {layout === 'mobile' ? (
        <DateWheels value={choice ?? startChoice} today={today} onChange={setChoice} allowSomeday={allowSomeday} showTime={showTime} />
      ) : (
        <DateEditor
          mode="inline"
          value={startChoice}
          today={today}
          allowSomeday={allowSomeday}
          showTime={showTime}
          autoFocus
          onDraftChange={setChoice}
          onCommit={confirm}
        />
      )}
      <Button type="submit" fullWidth disabled={choice === null}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" fullWidth onClick={onClose}>
        {t('common.close')}
      </Button>
    </form>
  );
}
