import { useEffect } from 'react';
import { t } from '../../i18n';
import { Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { settingsStore } from './settingsStore';
import './SettingsScreen.css';

/**
 * Écran Réglages minimal (Reglages.html), limité à la section « TÂCHES » et à
 * l'interrupteur « Reporter les tâches non faites » (T-06). Aucun autre réglage
 * n'est simulé : ils arrivent avec M12.
 */
export function SettingsScreen() {
  const load = useFeatureStore(settingsStore, (s) => s.load);
  const carryOverUndone = useFeatureStore(settingsStore, (s) => s.carryOverUndone);
  const status = useFeatureStore(settingsStore, (s) => s.status);
  const errorKey = useFeatureStore(settingsStore, (s) => s.errorKey);
  const setCarryOverUndone = useFeatureStore(settingsStore, (s) => s.setCarryOverUndone);

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
    </div>
  );
}
