import type { DateChoice } from '../domain/dateInput';
import type { LocalDate } from '../domain/types';
import { DateField } from './DateField';
import { DateWheels } from './DateWheels';
import { useLayout } from './useLayout';

export interface DatePickerProps {
  /** Choix courant ; `date` null = « Un jour ». Sur PC, null = champ vide. */
  value: DateChoice | null;
  /** Aujourd'hui, fourni par l'appelant (horloge du conteneur). */
  today: LocalDate;
  /** Nouveau choix ; sur PC, null quand le champ est vidé. */
  onChange: (choice: DateChoice | null) => void;
  allowSomeday?: boolean;
  /** « Un jour » grisé avec cette aide (tâche récurrente, QB-11). */
  somedayDisabledHint?: string;
  /** Heure choisie avec la date (défaut : oui). */
  showTime?: boolean;
  /** PC : ouvre la fenêtre au-dessus du champ (champ en bas d'écran). */
  placement?: 'below' | 'above' | 'auto';
  /** PC : nom accessible du champ (défaut : « Date »). */
  label?: string;
  className?: string;
}

/**
 * Sélecteur de date adapté à l'appareil (T-14) : sur iPhone, puces et roues jour / heure / minutes
 * (`DateWheels`) ; sur PC, champ « Date » à saisie libre avec mini-calendrier (`DateField`). C'est le même
 * composant pour la saisie, le détail, « Choisir une date » (T-05), la duplication (T-12) et la planification (SD-02).
 *
 * @example
 * <DatePicker value={choice} today={today} onChange={(c) => setChoice(c)} />
 */
export function DatePicker({ value, today, onChange, allowSomeday = true, somedayDisabledHint, showTime = true, placement = 'auto', label, className }: DatePickerProps) {
  const layout = useLayout();
  if (layout === 'mobile') {
    return (
      <DateWheels
        value={value ?? { date: today, time: null }}
        today={today}
        onChange={onChange}
        allowSomeday={allowSomeday}
        {...(somedayDisabledHint ? { somedayDisabledHint } : {})}
        showTime={showTime}
        {...(className ? { className } : {})}
      />
    );
  }
  return (
    <DateField
      value={value}
      today={today}
      onChange={onChange}
      allowSomeday={allowSomeday}
      {...(somedayDisabledHint ? { somedayDisabledHint } : {})}
      showTime={showTime}
      placement={placement}
      {...(label ? { label } : {})}
      {...(className ? { className } : {})}
    />
  );
}
