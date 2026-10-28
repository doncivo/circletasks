import type { ReactNode } from 'react';
import type { ChecklistProgress } from '../../domain/checklistRules';
import { t } from '../../i18n';
import { tChecklistsRefonte } from '../../i18n/checklistsRefonteText';

export interface ChecklistProgressBarProps {
  readonly progress: ChecklistProgress;
  /** Mention à droite (PC : « Perso · modèle réutilisable ») ou commande (iPhone : « Réorganiser », UI-REFONTE-06). */
  readonly trailing?: ReactNode;
  /** iPhone (UI-REFONTE-06, Checklists-v2.html) : barre fine et « 2 sur 3 » ; PC : « 3 / 6 ». */
  readonly mobile?: boolean;
}

/**
 * Barre de progression et compte (Checklists.html : barre de 8 px #EEEAF3, remplissage #3E7C5A ; Checklists-v2.html : barre de 6 px et
 * « 2 sur 3 »). Sans item : compte seul, barre masquée (C-02 critère 6). La progression est annoncée aux lecteurs d'écran à chaque cochage
 * (`aria-live`), avec le même libellé sur PC et iPhone.
 */
export function ChecklistProgressBar({ progress, trailing, mobile = false }: ChecklistProgressBarProps) {
  const { checked, total, ratio } = progress;
  const label = t('checklists.progressLabel', { checked, total });
  return (
    <div className="ct-checklist-progress" data-layout={mobile ? 'mobile' : undefined}>
      {total > 0 && (
        <div className="ct-checklist-progress__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={checked}>
          <div className="ct-checklist-progress__fill" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
        </div>
      )}
      <span className="ct-checklist-progress__count" role="status" aria-live="polite" aria-label={label}>
        {mobile ? tChecklistsRefonte('progress', { checked, total }) : t('checklists.progress', { checked, total })}
      </span>
      {trailing !== undefined && trailing !== null && trailing !== '' && (typeof trailing === 'string' ? <span className="ct-checklist-progress__trailing">{trailing}</span> : trailing)}
    </div>
  );
}
