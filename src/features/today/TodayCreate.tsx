import { useState, type FormEvent, type RefObject } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { DatePicker, TextField, type Layout } from '../../ui';

export interface TodayAddRowProps {
  readonly layout: Layout;
  readonly today: LocalDate;
  readonly inputRef: RefObject<HTMLInputElement>;
  /** Crée la tâche ; rend true si elle l'est (le champ se vide). */
  readonly onSubmit: (title: string, choice: DateChoice | null) => Promise<boolean>;
}

/**
 * Champ « Ajouter une tâche » (Main.html, PC-Aujourdhui.html) : pleine largeur. Sur PC, le champ « Date » à saisie libre
 * (T-14) est intégré à droite du même cadre gris ; sur iPhone, la date se règle dans la feuille « Nouvelle tâche » (Fab).
 */
export function TodayAddRow({ layout, today, inputRef, onSubmit }: TodayAddRowProps) {
  const [title, setTitle] = useState('');
  const [choice, setChoice] = useState<DateChoice | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await onSubmit(title, choice)) {
      setTitle('');
      setChoice(null);
      inputRef.current?.focus();
    }
  }

  return (
    <form className="ct-today__addRow" data-layout={layout} onSubmit={submit}>
      <TextField
        ref={inputRef}
        label={t('tasks.newTask')}
        placeholder={t(layout === 'pc' ? 'tasks.addPlaceholderPc' : 'tasks.addPlaceholder')}
        value={title}
        onChange={setTitle}
        maxLength={TASK_TITLE_MAX_LENGTH}
        className="ct-today__addField"
      />
      {layout === 'pc' && <DatePicker value={choice} today={today} onChange={setChoice} className="ct-today__dateField" />}
      {/* Bouton d'envoi masqué : avec deux champs texte (titre, date), Entrée ne soumet le formulaire que par lui. */}
      <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
    </form>
  );
}
