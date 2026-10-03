import { SomedayIcon, useLayout } from '../../ui';
import { t } from '../../i18n';
import { useNavigationStore } from '../app/navigation';
import { useSomedayTasks } from './useSomedayTasks';
import './SomedayButton.css';

/**
 * Icône horloge « Un jour » du haut d'Aujourd'hui (Main.html, SD-01 critère 1) : ouvre l'écran (iPhone) ou le panneau (PC).
 * Badge du nombre de tâches non terminées du filtre actif (critère 6), absent à 0 ; libellé accessible « Un jour, 6 tâches ».
 */
export function SomedayButton() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const { count } = useSomedayTasks();
  const label = count === 0 ? t('someday.open') : count === 1 ? t('someday.openCountOne') : t('someday.openCount', { count });
  return (
    <button
      type="button"
      className="ct-someday-button"
      aria-label={label}
      onClick={() => {
        closeDetail();
        navigate({ tab: 'tasks', screen: 'someday' });
      }}
    >
      <SomedayIcon size={layout === 'pc' ? 24 : 26} />
      {count > 0 && (
        <span className="ct-someday-button__badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
