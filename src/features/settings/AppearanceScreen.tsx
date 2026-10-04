import { Undo2 } from 'lucide-react';
import { useEffect } from 'react';
import { FIRST_WEEKDAYS, firstWeekdayIso, type FirstWeekday } from '../../domain/week';
import { TIME_FORMATS, type TimeFormat } from '../../domain/timeFormat';
import { t } from '../../i18n';
import { formatTime, weekdayNameOf } from '../../i18n/format';
import { Icon, SegmentedControl, useLayout } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { settingsStore } from './settingsStore';
import './AppearanceScreen.css';

const WEEKDAY_KEY = { monday: 'appearance.monday', saturday: 'appearance.saturday', sunday: 'appearance.sunday' } as const satisfies Record<FirstWeekday, string>;
const FORMAT_KEY = { '24h': 'appearance.format24', '12h': 'appearance.format12' } as const satisfies Record<TimeFormat, string>;

/** Valeur de la ligne Réglages › GÉNÉRAL « Thème · semaine · heure » : « lundi · 24 h » (le thème s'y ajoute avec P-02). */
export function formatAppearanceParts(firstWeekday: FirstWeekday, timeFormat: TimeFormat): string[] {
  return [weekdayNameOf(firstWeekdayIso(firstWeekday)), t(FORMAT_KEY[timeFormat])];
}

/**
 * Écran « Apparence et formats » (M12, P-03), ouvert depuis Réglages › GÉNÉRAL. Non dessiné : sections et lignes de Reglages.html,
 * contrôles segmentés comme `SpaceSegmented`. Sections SEMAINE, LANGUE (lecture seule) et HEURE ; le thème (P-02) s'y ajoute en tête.
 */
export function AppearanceScreen() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const load = useFeatureStore(settingsStore, (s) => s.load);
  const errorKey = useFeatureStore(settingsStore, (s) => s.errorKey);
  const firstWeekday = useFeatureStore(settingsStore, (s) => s.firstWeekday);
  const timeFormat = useFeatureStore(settingsStore, (s) => s.timeFormat);
  const setFirstWeekday = useFeatureStore(settingsStore, (s) => s.setFirstWeekday);
  const setTimeFormat = useFeatureStore(settingsStore, (s) => s.setTimeFormat);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ct-appearance-shell" data-layout={layout}>
      <div className="ct-appearance">
        <div className="ct-appearance__topRow">
          <button type="button" className="ct-appearance__back" aria-label={t('appearance.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-appearance__title">{t('appearance.title')}</h1>
        {errorKey && (
          <p className="ct-appearance__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        {/* --- Section THÈME (P-02) --- */}
        {/* --- fin section THÈME --- */}
        <h2 className="ct-appearance__section">{t('appearance.sectionWeek')}</h2>
        <div className="ct-appearance__field">
          <span className="ct-appearance__label">{t('appearance.firstDay')}</span>
          <SegmentedControl
            label={t('appearance.firstDayLabel')}
            value={firstWeekday}
            onChange={(value) => void setFirstWeekday(value)}
            options={FIRST_WEEKDAYS.map((value) => ({ value, label: t(WEEKDAY_KEY[value]) }))}
          />
        </div>
        <p className="ct-appearance__hint">{t('appearance.weekHint')}</p>
        <h2 className="ct-appearance__section">{t('appearance.sectionLanguage')}</h2>
        <div className="ct-appearance__row">
          <span>{t('appearance.language')}</span>
          <span className="ct-appearance__value">{t('appearance.languageValue')}</span>
        </div>
        <p className="ct-appearance__hint">{t('appearance.languageHint')}</p>
        <h2 className="ct-appearance__section">{t('appearance.sectionTime')}</h2>
        <div className="ct-appearance__field">
          <span className="ct-appearance__label">{t('appearance.timeFormat')}</span>
          <SegmentedControl
            label={t('appearance.timeFormatLabel')}
            value={timeFormat}
            onChange={(value) => void setTimeFormat(value)}
            options={TIME_FORMATS.map((value) => ({ value, label: t(FORMAT_KEY[value]) }))}
          />
        </div>
        <p className="ct-appearance__hint" aria-live="polite">
          {t('appearance.timeExample', { time: formatTime('15:30') })}
        </p>
      </div>
    </div>
  );
}
