import { t } from '../../i18n';
import { Button } from '../../ui';
import { useNavigationStore } from '../app/navigation';

/** Ligne « Importer des tâches (CSV) » de Réglages › DONNÉES ET SÉCURITÉ (même style que « Sauvegarde automatique », P-07 critère 1). */
export function ImportRow() {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <div className="ct-settings__row">
      <span>{t('importCsv.row')}</span>
      <Button variant="secondary" ariaLabel={t('importCsv.rowOpenLabel')} onClick={() => navigate({ tab: 'settings', screen: 'import' })} className="ct-settings__link">
        {t('importCsv.rowOpen')}
      </Button>
    </div>
  );
}
