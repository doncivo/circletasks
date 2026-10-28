import { useRef, type FormEvent } from 'react';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatAddDayLabel, tWeekRefonte } from '../../i18n/weekRefonteText';
import { Fab, QuickInputField, QuickPreview } from '../../ui';
import { captureInputFrom, useQuickInput, type CaptureInput } from '../capture';
import { useEffectiveProjectFilter } from '../spaces';

export interface WeekAddRowProps {
  /** Jour visé par l'ajout (jour sélectionné dans la liste, aujourd'hui par défaut). */
  readonly date: LocalDate;
  /** Crée la tâche du jour visé ; rend true si elle l'est (le champ se vide et garde le focus). */
  readonly onAdd: (capture: CaptureInput) => Promise<boolean>;
  /** Bouton « + » : feuille « Nouvelle tâche » datée du jour visé. */
  readonly onOpenCreate: () => void;
}

/**
 * Rangée d'ajout unique de la Semaine iPhone (UI-REFONTE-03, Semaine-v2.html) : champ « Ajouter à jeudi 24 » visant le jour sélectionné,
 * bouton « + » à droite, au-dessus de la zone de sécurité. Même saisie rapide que `WeekDayAdd` (Q-06, Q-02 : « #perso », « @projet »,
 * une date ou une heure écrite est annoncée par la pastille et l'emporte sur le jour visé) ; le titre suit la règle de T-01.
 */
export function WeekAddRow({ date, onAdd, onOpenCreate }: WeekAddRowProps) {
  const quick = useQuickInput();
  const projectFilter = useEffectiveProjectFilter();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const capture = captureInputFrom(await quick.parseNowLoaded(), quick.defaultSpaceId, projectFilter);
    if (!validateTaskTitle(capture.title).ok || busy.current) return;
    busy.current = true;
    try {
      if (await onAdd(capture)) {
        quick.reset();
        inputRef.current?.focus();
      }
    } finally {
      busy.current = false;
    }
  }

  return (
    <div className="ct-week__addRow">
      <div className="ct-week__addRowField">
        <form className="ct-week__addRowForm" onSubmit={(event) => void submit(event)}>
          <QuickInputField
            ref={inputRef}
            label={tWeekRefonte('addLabel')}
            placeholder={tWeekRefonte('addTo', { day: formatAddDayLabel(date) })}
            value={quick.text}
            onChange={quick.setText}
            maxLength={TASK_TITLE_MAX_LENGTH}
            enterKeyHint="done"
            context={quick.suggestionContext}
            placement="above"
          />
        </form>
        <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={quick.today} onDismiss={quick.dismiss} />
      </div>
      <Fab onClick={onOpenCreate} label={t('common.add')} />
    </div>
  );
}
