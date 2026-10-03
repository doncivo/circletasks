import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatDayLabel } from '../../i18n/format';

export interface ChecklistDateRowProps {
  readonly date: LocalDate | null;
  /** Ouvre le sélecteur de date (T-14). */
  readonly onPick: () => void;
  /** Retire la date (annulable 5 s, C-03 critère 6). */
  readonly onClear: () => void;
}

/** Ligne « Date » de la feuille « Modifier la checklist » (C-03 critère 1, décision D3) : choisir ou retirer le jour associé. */
export function ChecklistDateRow({ date, onPick, onClear }: ChecklistDateRowProps) {
  const shown = date ? formatDayLabel(date) : t('checklists.date.none');
  return (
    <div className="ct-checklist-form__row">
      <span className="ct-checklist-form__label">{t('checklists.date.label')}</span>
      <button type="button" className="ct-checklist-form__pill" aria-label={t('checklists.date.button', { date: shown })} onClick={onPick}>
        {shown}
      </button>
      {date && (
        <button type="button" className="ct-checklist-form__link" onClick={onClear}>
          {t('checklists.date.remove')}
        </button>
      )}
    </div>
  );
}
