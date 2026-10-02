import { ChevronRight, Undo2 } from 'lucide-react';
import { t } from '../../i18n';
import { Icon } from '../../ui';
import { DEFAULT_ROUTES, useNavigationStore } from '../app/navigation';
import './DoneTasksScreen.css';

/**
 * Écran « Rapport mensuel » (Rapport.html), ouvert par l'icône graphique d'Aujourd'hui.
 * Version minimale de l'ordre 1 (T-07, décision Q5) : le rapport lui-même (tuiles, taux
 * de complétion, carte de chaleur) est H-01, ordre 3 ; seul le lien « Tâches terminées »
 * est livré ici, rien n'est simulé.
 */
export function ReportScreen() {
  const navigate = useNavigationStore((s) => s.navigate);

  return (
    <div className="ct-done">
      <div className="ct-done__topRow">
        <button type="button" className="ct-done__iconButton" aria-label={t('report.back')} onClick={() => navigate(DEFAULT_ROUTES.tasks)}>
          <Icon icon={Undo2} size={26} />
        </button>
      </div>
      <h1 className="ct-done__title">{t('report.title')}</h1>
      <button type="button" className="ct-done__link" onClick={() => navigate({ tab: 'tasks', screen: 'done' })}>
        <span>{t('report.openDone')}</span>
        <Icon icon={ChevronRight} size={20} />
      </button>
    </div>
  );
}
