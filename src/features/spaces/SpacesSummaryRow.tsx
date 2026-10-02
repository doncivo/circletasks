import { useEffect } from 'react';
import { activeProjectCount } from '../../domain/spaceRules';
import { t } from '../../i18n';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { spacesStore } from './spacesStore';

/**
 * Ligne « Espaces et projets » de Réglages (Reglages.html) : résumé « Pro (3) · Perso (2) » = espaces et nombre de projets actifs
 * (ES-01 critère 2). Ouvre l'écran de gestion.
 */
export function SpacesSummaryRow() {
  const navigate = useNavigationStore((s) => s.navigate);
  const spaces = useAppStore((s) => s.spaces);
  const load = useFeatureStore(spacesStore, (s) => s.load);
  const projects = useFeatureStore(spacesStore, (s) => s.projects);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = spaces.map((space) => t('spaces.summaryItem', { name: space.name, count: activeProjectCount(projects, space.id) })).join(t('spaces.summarySeparator'));
  return (
    <button
      type="button"
      className="ct-settings__row ct-settings__rowButton"
      aria-label={`${t('spaces.settingsRow')} : ${summary}`}
      onClick={() => navigate({ tab: 'settings', screen: 'spaces' })}
    >
      <span>{t('spaces.settingsRow')}</span>
      <span className="ct-settings__value">{summary}</span>
    </button>
  );
}
