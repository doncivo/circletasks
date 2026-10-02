import { useEffect } from 'react';
import { t } from '../../i18n';
import { Button, Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { AboutSection } from './AboutSection';
import { settingsStore } from './settingsStore';
import './SettingsScreen.css';

/**
 * Écran Réglages minimal (Reglages.html) : section « TÂCHES » avec l'interrupteur « Reporter
 * les tâches non faites » (T-06), section « DONNÉES ET SÉCURITÉ » avec la seule ligne
 * « Corbeille » (T-08, Q6 : unique point d'accès). Sur PC seulement : section « GÉNÉRAL » avec
 * « Démarrer avec Windows » (D-02) et section « À PROPOS » (D-03). Aucun autre réglage n'est
 * simulé : ils arrivent avec M12.
 */
export function SettingsScreen() {
  const load = useFeatureStore(settingsStore, (s) => s.load);
  const carryOverUndone = useFeatureStore(settingsStore, (s) => s.carryOverUndone);
  const status = useFeatureStore(settingsStore, (s) => s.status);
  const errorKey = useFeatureStore(settingsStore, (s) => s.errorKey);
  const setCarryOverUndone = useFeatureStore(settingsStore, (s) => s.setCarryOverUndone);
  const launchAtStartup = useFeatureStore(settingsStore, (s) => s.launchAtStartup);
  const setLaunchAtStartup = useFeatureStore(settingsStore, (s) => s.setLaunchAtStartup);
  const navigate = useNavigationStore((s) => s.navigate);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ct-settings">
      <h1 className="ct-settings__title">{t('settings.title')}</h1>
      <div className="ct-settings__rule" aria-hidden="true">
        <div className="ct-settings__ruleAccent" />
        <div className="ct-settings__ruleLine" />
      </div>
      {errorKey && (
        <p className="ct-settings__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      {launchAtStartup !== null && (
        <>
          <h2 className="ct-settings__section">{t('settings.sectionGeneral')}</h2>
          <div className="ct-settings__row">
            <span>{t('settings.launchAtStartup')}</span>
            <Switch checked={launchAtStartup} onChange={(value) => void setLaunchAtStartup(value)} label={t('settings.launchAtStartup')} />
          </div>
        </>
      )}
      <h2 className="ct-settings__section">{t('settings.sectionTasks')}</h2>
      <div className="ct-settings__row">
        <span>{t('settings.carryOverUndone')}</span>
        <Switch
          checked={carryOverUndone}
          onChange={(value) => void setCarryOverUndone(value)}
          label={t('settings.carryOverUndone')}
          disabled={status !== 'ready' && status !== 'error'}
        />
      </div>
      <h2 className="ct-settings__section">{t('settings.sectionData')}</h2>
      <div className="ct-settings__row">
        <span>{t('settings.trash')}</span>
        <Button
          variant="secondary"
          ariaLabel={t('settings.trashOpenLabel')}
          onClick={() => navigate({ tab: 'settings', screen: 'trash' })}
          className="ct-settings__link"
        >
          {t('settings.trashOpen')}
        </Button>
      </div>
      <AboutSection />
    </div>
  );
}
