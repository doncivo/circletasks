import type { ChecklistProgress } from '../../domain/checklistRules';
import { t } from '../../i18n';

/**
 * Barre de progression et « 3 / 6 » (Checklists.html : barre de 8 px #EEEAF3, remplissage #3E7C5A). Sans item : « 0 / 0 », barre
 * masquée (C-02 critère 6). La progression est annoncée aux lecteurs d'écran à chaque cochage (`aria-live`).
 */
export function ChecklistProgressBar({ progress, trailing }: { progress: ChecklistProgress; trailing?: string }) {
  const { checked, total, ratio } = progress;
  return (
    <div className="ct-checklist-progress">
      {total > 0 && (
        <div
          className="ct-checklist-progress__bar"
          role="progressbar"
          aria-label={t('checklists.progressLabel', { checked, total })}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={checked}
        >
          <div className="ct-checklist-progress__fill" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
        </div>
      )}
      <span className="ct-checklist-progress__count" role="status" aria-live="polite" aria-label={t('checklists.progressLabel', { checked, total })}>
        {t('checklists.progress', { checked, total })}
      </span>
      {trailing && <span className="ct-checklist-progress__trailing">{trailing}</span>}
    </div>
  );
}
