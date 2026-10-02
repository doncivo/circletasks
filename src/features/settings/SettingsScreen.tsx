import { useEffect } from 'react';
import { t } from '../../i18n';
import { Button, Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { formatRecapSummary } from '../reminders';
import { SpacesSummaryRow } from '../spaces';
import { AboutSection } from './AboutSection';
import { settingsStore } from './settingsStore';
import './SettingsScreen.css';

/**
 * Écran Réglages minimal (Reglages.html) : section « GÉNÉRAL » avec la seule ligne « Fuseau horaire » (T-11, lecture seule), section « TÂCHES » avec les interrupteurs « Reporter
 * les tâches non faites » (T-06) et « Masquer les routines de la liste » (A-03), section « DONNÉES ET SÉCURITÉ » avec la seule ligne
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
  const hideRoutines = useFeatureStore(settingsStore, (s) => s.hideRoutines);
  const setHideRoutines = useFeatureStore(settingsStore, (s) => s.setHideRoutines);
  const recaps = useFeatureStore(settingsStore, (s) => s.recaps);
  const timeZone = useAppStore((s) => s.timeZone);
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
      <h2 className="ct-settings__section">{t('settings.sectionGeneral')}</h2>
      <div className="ct-settings__row">
        <span>{t('settings.timeZone')}</span>
        <span className="ct-settings__value">
          {timeZone ? t('settings.timeZoneAuto', { zone: timeZone }) : t('settings.timeZoneUnknown')}
        </span>
      </div>
      {launchAtStartup !== null && (
        <div className="ct-settings__row">
          <span>{t('settings.launchAtStartup')}</span>
          <Switch checked={launchAtStartup} onChange={(value) => void setLaunchAtStartup(value)} label={t('settings.launchAtStartup')} />
        </div>
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
      <div className="ct-settings__row">
        <span>{t('settings.hideRoutines')}</span>
        <Switch
          checked={hideRoutines}
          onChange={(value) => void setHideRoutines(value)}
          label={t('settings.hideRoutines')}
          disabled={status !== 'ready' && status !== 'error'}
        />
      </div>
      <h2 className="ct-settings__section">{t('reminders.sectionTitle')}</h2>
      <button
        type="button"
        className="ct-settings__row ct-settings__rowButton"
        aria-label={`${t('reminders.recaps')} : ${formatRecapSummary(recaps)}`}
        onClick={() => navigate({ tab: 'settings', screen: 'reminders' })}
      >
        <span>{t('reminders.recaps')}</span>
        <span className="ct-settings__value">{formatRecapSummary(recaps)}</span>
      </button>
      <h2 className="ct-settings__section">{t('spaces.sectionTitle')}</h2>
      <SpacesSummaryRow />
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
