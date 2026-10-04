import { useEffect, useState } from 'react';
import { DEFAULT_HOLIDAY_COUNTRIES, type HolidayCountries } from '../../domain/holidays';
import { t } from '../../i18n';
import { useAppContainer } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { enabledCountriesLabel } from './holidayText';
import { readHolidayCountries } from './holidayUseCases';

/**
 * Ligne « Jours fériés — France, Tunisie » de Réglages (section TÂCHES, Reglages.html, E-03 critère 9) : ouvre l'écran des deux
 * interrupteurs. La valeur liste les calendriers activés (« Aucun » si tous sont désactivés). Mêmes classes que les autres lignes
 * de Réglages (`SettingsScreen.css`).
 */
export function HolidaysSummaryRow() {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const [countries, setCountries] = useState<HolidayCountries>(DEFAULT_HOLIDAY_COUNTRIES);

  useEffect(() => {
    let alive = true;
    readHolidayCountries(container).then(
      (value) => alive && setCountries(value),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [container]);

  const value = enabledCountriesLabel(countries) ?? t('events.holidaySettings.rowValueNone');
  return (
    <button type="button" className="ct-settings__row ct-settings__rowButton" aria-label={`${t('settings.holidays')} : ${value}`} onClick={() => navigate({ tab: 'settings', screen: 'holidays' })}>
      <span>{t('settings.holidays')}</span>
      <span className="ct-settings__value">{value}</span>
    </button>
  );
}
