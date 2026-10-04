import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { DEFAULT_HOLIDAY_COUNTRIES, uncoveredLunarYears, type HolidayCountries } from '../../domain/holidays';
import { parseLocalDate } from '../../domain/localDate';
import type { HolidayCountry } from '../../domain/model';
import { t } from '../../i18n';
import { Icon, Switch, useLayout } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { createHolidayUseCases, readHolidayCountries } from './holidayUseCases';
import './HolidaySettingsScreen.css';

/**
 * Écran « Jours fériés » (E-03 critère 9), ouvert depuis la ligne « Jours fériés » de Réglages (section TÂCHES) : deux interrupteurs,
 * France et Tunisie, activés par défaut (Reglages.html : « France, Tunisie »). Désactiver un pays retire ses fériés de la liste, de la
 * grille, d'Aujourd'hui et de la Semaine sans toucher à l'autre ; l'état est conservé. Signale les années proches sans fêtes
 * religieuses (« Dates religieuses non disponibles pour 2031 », rappel de mise à jour annuelle de la table). Écran non dessiné dans les
 * maquettes : mêmes codes que « Récapitulatifs ».
 */
export function HolidaySettingsScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const [countries, setCountries] = useState<HolidayCountries>(DEFAULT_HOLIDAY_COUNTRIES);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    readHolidayCountries(container).then(
      (value) => {
        if (!alive) return;
        setCountries(value);
        setReady(true);
      },
      () => alive && setReady(true),
    );
    return () => {
      alive = false;
    };
  }, [container]);

  async function toggle(country: HolidayCountry, enabled: boolean): Promise<void> {
    const previous = countries;
    setCountries({ ...countries, [country]: enabled });
    try {
      await createHolidayUseCases(container).setCountry(country, enabled);
      setFailed(false);
    } catch {
      setCountries(previous);
      setFailed(true);
    }
  }

  const year = parseLocalDate(today).year;
  const uncovered = uncoveredLunarYears([year, year + 1], countries);

  return (
    <div className="ct-holiday-settings-shell" data-layout={layout}>
      <div className="ct-holiday-settings">
        <div className="ct-holiday-settings__topRow">
          <button type="button" className="ct-holiday-settings__back" aria-label={t('events.holidaySettings.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-holiday-settings__title">{t('events.holidaySettings.title')}</h1>
        <p className="ct-holiday-settings__hint">{t('events.holidaySettings.hint')}</p>
        {failed && (
          <p className="ct-holiday-settings__error" role="alert">
            {t('events.holidaySettings.saveError')}
          </p>
        )}
        <div className="ct-holiday-settings__row">
          <span>{t('events.holidaySettings.france')}</span>
          <Switch checked={countries.FR} onChange={(value) => void toggle('FR', value)} label={t('events.holidaySettings.switchFrance')} disabled={!ready} />
        </div>
        <div className="ct-holiday-settings__row">
          <span>{t('events.holidaySettings.tunisia')}</span>
          <Switch checked={countries.TN} onChange={(value) => void toggle('TN', value)} label={t('events.holidaySettings.switchTunisia')} disabled={!ready} />
        </div>
        {uncovered.map((missing) => (
          <p key={missing} className="ct-holiday-settings__notice" role="status">
            {t('events.holidaySettings.uncovered', { year: missing })}
          </p>
        ))}
      </div>
    </div>
  );
}
