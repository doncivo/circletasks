import { useState, type FormEvent, type RefObject } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { DatePicker, QuickInputField, QuickPreview, type Layout } from '../../ui';
import { captureInputFrom, DictationButton, DictationHelp, ListeningSheet, useDictation, useQuickInput, type CaptureInput } from '../capture';
import { ScanButton } from '../capture/scan/ScanButton';
import { useEffectiveProjectFilter } from '../spaces';

export interface TodayAddRowProps {
  readonly layout: Layout;
  readonly today: LocalDate;
  readonly inputRef: RefObject<HTMLInputElement>;
  /** Crée la tâche ; rend true si elle l'est (le champ se vide). `choice` : date réglée à la main (PC), qui l'emporte sur celle du texte. */
  readonly onSubmit: (capture: CaptureInput, choice: DateChoice | null) => Promise<boolean>;
}

/**
 * Champ « Ajouter une tâche » (Main.html, PC-Aujourdhui.html) : pleine largeur. Sur PC, le champ « Date » à saisie libre
 * (T-14) est intégré à droite du même cadre gris ; sur iPhone, la date se règle dans la feuille « Nouvelle tâche » (Fab).
 * Le texte est analysé à la frappe (Q-06, Q-02) : « Relancer client demain 9h #pro @mission » ; l'aperçu est sous le champ.
 */
export function TodayAddRow({ layout, today, inputRef, onSubmit }: TodayAddRowProps) {
  const [choice, setChoice] = useState<DateChoice | null>(null);
  const projectFilter = useEffectiveProjectFilter();
  // Une date réglée à la main l'emporte : le texte n'est plus lu pour la date.
  const quick = useQuickInput({ dates: choice === null });
  // Q-03 : micro à droite du champ (PC : aide « Win + H », le texte dicté arrive dans le champ pour relecture ; iPhone : seulement si le plugin Speech existe).
  const dictation = useDictation({ layout, inputRef, onText: (spoken) => quick.setText(quick.text === '' ? spoken : `${quick.text} ${spoken}`) });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const capture = captureInputFrom(quick.parseNow(), quick.defaultSpaceId, projectFilter);
    if (await onSubmit(capture, choice)) {
      quick.reset();
      setChoice(null);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="ct-today__addBlock">
      {/* PC-Aujourdhui.html : « Scan tâches » à droite du champ ; Main.html : sous le champ (Q-04). */}
      <div className="ct-today__addLine" data-layout={layout}>
      <form className="ct-today__addRow" data-layout={layout} onSubmit={submit}>
        <QuickInputField
          ref={inputRef}
          label={t('tasks.newTask')}
          placeholder={t(layout === 'pc' ? 'tasks.addPlaceholderPc' : 'tasks.addPlaceholder')}
          value={quick.text}
          onChange={quick.setText}
          maxLength={TASK_TITLE_MAX_LENGTH}
          context={quick.suggestionContext}
          placement={layout === 'pc' ? 'below' : 'above'}
          className="ct-today__addField"
          {...(dictation.showButton ? { describedBy: dictation.helpId } : {})}
        />
        <DictationButton dictation={dictation} />
        {layout === 'pc' && <DatePicker value={choice} today={today} onChange={setChoice} className="ct-today__dateField" />}
        {/* Bouton d'envoi masqué : avec deux champs texte (titre, date), Entrée ne soumet le formulaire que par lui. */}
        <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
      </form>
      {layout === 'pc' && <ScanButton layout={layout} />}
      </div>
      <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={today} onDismiss={quick.dismiss} />
      <DictationHelp dictation={dictation} />
      <ListeningSheet dictation={dictation} />
      {layout === 'mobile' && (
        <div className="ct-today__scanRow">
          <ScanButton layout={layout} />
        </div>
      )}
    </div>
  );
}
