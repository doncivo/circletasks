import type { Task } from '../../domain/model';
import type { ScheduleSomedayTarget } from '../../domain/someday';
import { t } from '../../i18n';

export interface SomedayScheduleProps {
  readonly task: Task;
  /** « Aujourd'hui » ou « Demain » : planification en un geste (SD-02 critères 2 et 3). */
  readonly onPlan: (target: Extract<ScheduleSomedayTarget, string>) => void;
  /** « Choisir une date » : ouvre le sélecteur de date (T-14). */
  readonly onPick: () => void;
  /** « Ouvrir la fiche » : détail de la tâche (A-08), accès aux notes, à l'icône, à la suppression. */
  readonly onOpen: () => void;
}

/**
 * Boutons d'une ligne déployée (UnJour.html : « Aujourd'hui », « Demain », « Choisir une date », pastilles de 36 px). Noms accessibles
 * complets pour VoiceOver : « Planifier aujourd'hui : Renouveler le passeport » (SD-02 critère 7).
 */
export function SomedaySchedule({ task, onPlan, onPick, onOpen }: SomedayScheduleProps) {
  return (
    <div className="ct-someday__schedule" role="group" aria-label={t('someday.planActions', { title: task.title })}>
      <button type="button" className="ct-someday__action" aria-label={t('someday.planTodayLabel', { title: task.title })} onClick={() => onPlan('today')}>
        {t('someday.planToday')}
      </button>
      <button type="button" className="ct-someday__action" aria-label={t('someday.planTomorrowLabel', { title: task.title })} onClick={() => onPlan('tomorrow')}>
        {t('someday.planTomorrow')}
      </button>
      <button type="button" className="ct-someday__action" aria-label={t('someday.planPickLabel', { title: task.title })} aria-haspopup="dialog" onClick={onPick}>
        {t('someday.planPick')}
      </button>
      <button type="button" className="ct-someday__action ct-someday__action--quiet" onClick={onOpen}>
        {t('someday.openCard')}
      </button>
    </div>
  );
}
