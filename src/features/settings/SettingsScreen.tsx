import { useEffect } from 'react';
import { t } from '../../i18n';
import { Button, Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { CalendarsSummaryRow } from '../calendars';
import { HolidaysSummaryRow } from '../events';
import { FocusSoundSetting } from '../focus/FocusSoundSetting';
import { formatRecapSummary } from '../reminders';
import { ShortcutsSettingsSection } from '../shortcuts';
import { QuietHoursRows, SpacesSummaryRow } from '../spaces';
import { SyncSettingsSection } from '../sync/SyncSettingsSection';
import { AboutSection } from './AboutSection';
import { BackupRow } from './BackupRow';
import { ImportRow } from './ImportRow';
import { SampleDataRow } from './SampleDataRow';
import { formatAppearanceParts } from './AppearanceScreen';
import { formatTabsSummary, useVisibleTabCount } from './TabsScreen';
import { settingsStore } from './settingsStore';
import './SettingsScreen.css';

/**
 * Écran Réglages minimal (Reglages.html) : section « GÉNÉRAL » avec la seule ligne « Fuseau horaire » (T-11, lecture seule), section « TÂCHES » avec les interrupteurs « Reporter
 * les tâches non faites » (T-06) et « Masquer les routines de la liste » (A-03), section « DONNÉES ET SÉCURITÉ » avec la seule ligne
 * « Corbeille » (T-08, Q6 : unique point d'accès). Sur PC seulement : section « GÉNÉRAL » avec
 * « Démarrer avec Windows » (D-02) et section « À PROPOS » (D-03). Section « SYNCHRONISATION » (Y-01, PC à l’ordre 4). Aucun autre réglage n’est
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
  const firstWeekday = useFeatureStore(settingsStore, (s) => s.firstWeekday);
  const timeFormat = useFeatureStore(settingsStore, (s) => s.timeFormat);
  const theme = useFeatureStore(settingsStore, (s) => s.theme);
  const visibleTabs = useVisibleTabCount();
  const appearanceSummary = formatAppearanceParts(theme, firstWeekday, timeFormat).join(t('appearance.summarySeparator'));

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
      {/* --- M12 apparence et formats --- */}
      <button
        type="button"
        className="ct-settings__row ct-settings__rowButton"
        aria-label={`${t('appearance.row')} : ${appearanceSummary}`}
        onClick={() => navigate({ tab: 'settings', screen: 'appearance' })}
      >
        <span>{t('appearance.row')}</span>
        <span className="ct-settings__value">{appearanceSummary}</span>
      </button>
      <div className="ct-settings__row">
        <span>{t('settings.timeZone')}</span>
        <span className="ct-settings__value">
          {timeZone ? t('settings.timeZoneAuto', { zone: timeZone }) : t('settings.timeZoneUnknown')}
        </span>
      </div>
      <button
        type="button"
        className="ct-settings__row ct-settings__rowButton"
        aria-label={`${t('appearance.tabsRow')} : ${formatTabsSummary(visibleTabs)}`}
        onClick={() => navigate({ tab: 'settings', screen: 'tabs' })}
      >
        <span>{t('appearance.tabsRow')}</span>
        <span className="ct-settings__value">{formatTabsSummary(visibleTabs)}</span>
      </button>
      {/* --- fin M12 apparence et formats --- */}
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
      {/* M10 (F-04) : son de fin de session, local à l'appareil. */}
      <FocusSoundSetting />
      <HolidaysSummaryRow />
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
      <QuietHoursRows />
      <h2 className="ct-settings__section">{t('spaces.sectionTitle')}</h2>
      <SpacesSummaryRow />
      <CalendarsSummaryRow />
      <ShortcutsSettingsSection />
      {/* M15 (Y-01) : dossier de synchro ; section absente sur iPhone jusqu'à l'ordre 5. */}
      <SyncSettingsSection />
      <h2 className="ct-settings__section">{t('settings.sectionData')}</h2>
      {/* M12 (P-04) : sauvegarde automatique quotidienne et restauration. */}
      <BackupRow />
      <ImportRow />
      <SampleDataRow />
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
