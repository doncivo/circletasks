import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import { tSettingsRefonte, type SettingsRefonteKey } from '../../i18n/settingsRefonteText';
import { Button, Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { CalendarsSummaryRow } from '../calendars';
import { HolidaysSummaryRow } from '../events';
import { FocusSoundSetting } from '../focus/FocusSoundSetting';
import { formatRecapSummary, SigningAboutRow } from '../reminders';
import { ShortcutsSettingsSection } from '../shortcuts';
import { QuietHoursRows, SpacesSummaryRow } from '../spaces';
import { SyncSettingsSection, useSyncAvailable } from '../sync/SyncSettingsSection';
import { AboutSection } from './AboutSection';
import { BackupRow } from './BackupRow';
import { ImportRow } from './ImportRow';
import { SampleDataRow } from './SampleDataRow';
import { SecuritySection } from './SecuritySection';
import { formatAppearanceParts } from './AppearanceScreen';
import { useTabCounts } from './TabsScreen';
import { settingsStore } from './settingsStore';

const SECTION_IDS = ['general', 'tasks', 'reminders', 'spaces', 'sync', 'data', 'keyboard', 'about'] as const;
type SectionId = (typeof SECTION_IDS)[number];
const SECTION_TITLES: Readonly<Record<SectionId, SettingsRefonteKey>> = {
  general: 'sectionGeneral',
  tasks: 'sectionTasks',
  reminders: 'sectionReminders',
  spaces: 'sectionSpaces',
  sync: 'sectionSync',
  data: 'sectionData',
  keyboard: 'sectionKeyboard',
  about: 'sectionAbout',
};
/** Après un clic du sommaire, le défilement observé ne reprend la main qu'une fois le défilement doux terminé. */
const PIN_MS = 800;

/**
 * Réglages sur PC (UI-REFONTE-09, PC-Reglages.html) : sommaire à gauche (huit sections, section courante), colonne de réglages bornée à
 * 660 px, titres de section en minuscules (Fraunces), « Général » en lignes séparées (Thème, Début de semaine, Format de l'heure, Fuseau
 * horaire, Onglets visibles, Démarrer avec Windows), chaque ligne cliquable avec son chevron. Les lignes et sections partagées avec l'iPhone
 * sont réutilisées telles quelles ; seules les sections qui portaient leur propre titre (`SyncSettingsSection`, `ShortcutsSettingsSection`,
 * `AboutSection`) le laissent au sommaire. Règle 7 des maquettes : sur grand écran, on borne et on navigue.
 */
export function SettingsScreenPc() {
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
  const tabs = useTabCounts();
  const syncAvailable = useSyncAvailable();
  const [themeText = '', weekdayText = '', formatText = ''] = formatAppearanceParts(theme, firstWeekday, timeFormat);
  const weekdayCapitalized = weekdayText.charAt(0).toLocaleUpperCase() + weekdayText.slice(1);
  const sections = SECTION_IDS.filter((id) => id !== 'sync' || syncAvailable);

  const [current, setCurrent] = useState<SectionId>('general');
  const refs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const pinnedUntil = useRef(0);

  useEffect(() => {
    void load();
  }, [load]);

  // Sommaire : la section courante suit le défilement (première section visible), sauf juste après un clic du sommaire.
  const sectionsKey = sections.join(',');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < pinnedUntil.current) return;
        const first = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
          ?.target.getAttribute('data-section');
        if (first) setCurrent(first as SectionId);
      },
      { rootMargin: '0px 0px -55% 0px' },
    );
    for (const id of sectionsKey.split(',') as SectionId[]) {
      const element = refs.current[id];
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sectionsKey]);

  function go(id: SectionId): void {
    pinnedUntil.current = Date.now() + PIN_MS;
    setCurrent(id);
    refs.current[id]?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  const section = (id: SectionId, children: ReactNode) => {
    const headingId = `ct-settings-section-${id}`;
    return (
      <section
        key={id}
        className="ct-settings__group"
        data-section={id}
        aria-labelledby={headingId}
        ref={(element) => {
          refs.current[id] = element;
        }}
      >
        <h2 id={headingId} className="ct-settings__section">
          {tSettingsRefonte(SECTION_TITLES[id])}
        </h2>
        {children}
      </section>
    );
  };

  const openAppearance = () => navigate({ tab: 'settings', screen: 'appearance' });
  const tabsCount = tSettingsRefonte('tabsCount', { visible: String(tabs.visible), total: String(tabs.total) });

  return (
    <div className="ct-settings ct-settings--pc">
      <aside className="ct-settings__summary">
        <h1 className="ct-settings__title">{t('settings.title')}</h1>
        {/* Groupe, pas `nav` : la coquille porte déjà le seul repère de navigation (la suite e2e le vise par son rôle). */}
        <div className="ct-settings__nav" role="group" aria-label={tSettingsRefonte('summaryLabel')}>
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              className="ct-settings__navItem"
              aria-current={current === id ? 'true' : undefined}
              onClick={() => go(id)}
            >
              {tSettingsRefonte(SECTION_TITLES[id])}
            </button>
          ))}
        </div>
      </aside>
      <div className="ct-settings__content">
        {errorKey && (
          <p className="ct-settings__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        <SigningAboutRow />
        {section(
          'general',
          <>
            <LinkRow label={tSettingsRefonte('theme')} value={themeText} onClick={openAppearance} />
            <LinkRow label={tSettingsRefonte('firstWeekday')} value={weekdayCapitalized} onClick={openAppearance} />
            <LinkRow label={tSettingsRefonte('timeFormat')} value={formatText} onClick={openAppearance} />
            <div className="ct-settings__row">
              <span className="ct-settings__stack">
                <span>{t('settings.timeZone')}</span>
                <span className="ct-settings__hint">{tSettingsRefonte('timeZoneHint')}</span>
              </span>
              <span className="ct-settings__value">{timeZone ?? t('settings.timeZoneUnknown')}</span>
            </div>
            <LinkRow label={tSettingsRefonte('tabsVisible')} value={tabsCount} onClick={() => navigate({ tab: 'settings', screen: 'tabs' })} />
            {launchAtStartup !== null && (
              <div className="ct-settings__row">
                <span className="ct-settings__stack">
                  <span>{t('settings.launchAtStartup')}</span>
                  <span className="ct-settings__hint">{tSettingsRefonte('launchHint')}</span>
                </span>
                <Switch checked={launchAtStartup} onChange={(value) => void setLaunchAtStartup(value)} label={t('settings.launchAtStartup')} />
              </div>
            )}
          </>,
        )}
        {section(
          'tasks',
          <>
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
            <FocusSoundSetting />
          </>,
        )}
        {section(
          'reminders',
          <>
            <LinkRow label={t('reminders.recaps')} value={formatRecapSummary(recaps)} onClick={() => navigate({ tab: 'settings', screen: 'reminders' })} />
            <QuietHoursRows />
          </>,
        )}
        {section(
          'spaces',
          <>
            <SpacesSummaryRow />
            <CalendarsSummaryRow />
            <HolidaysSummaryRow />
          </>,
        )}
        {syncAvailable && section('sync', <SyncSettingsSection heading={false} />)}
        {section(
          'data',
          <>
            <SecuritySection />
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
          </>,
        )}
        {section('keyboard', <ShortcutsSettingsSection heading={false} />)}
        {section('about', <AboutSection heading={false} />)}
      </div>
    </div>
  );
}

/** Ligne cliquable « étiquette · valeur » (chevron par la feuille de style) ; libellé accessible « étiquette : valeur ». */
function LinkRow({ label, value, onClick }: { readonly label: string; readonly value: string; readonly onClick: () => void }) {
  return (
    <button type="button" className="ct-settings__row ct-settings__rowButton" aria-label={`${label} : ${value}`} onClick={onClick}>
      <span>{label}</span>
      <span className="ct-settings__value">{value}</span>
    </button>
  );
}
