import { useEffect } from 'react';
import { t } from '../../i18n';
import { useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { calendarsStore } from './calendarsStore';

/**
 * Ligne « Agendas · Rappels Apple » de Réglages, section ESPACES ET CALENDRIERS (Reglages.html, K-01 critère 1 et D4) : « Aucun compte »
 * ou « N agendas » (agendas affichés de tous les comptes) ; elle ouvre l'écran Agendas. Les listes Rappels s'y ajouteront avec K-05.
 */
export function CalendarsSummaryRow() {
  const navigate = useNavigationStore((s) => s.navigate);
  const load = useFeatureStore(calendarsStore, (s) => s.load);
  const accounts = useFeatureStore(calendarsStore, (s) => s.accounts);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = accounts.reduce((total, account) => total + account.calendars.filter((calendar) => calendar.shown).length, 0);
  const value = accounts.length === 0 ? t('calendars.rowNone') : shown === 1 ? t('calendars.rowOne') : t('calendars.rowMany', { count: shown });
  return (
    <button type="button" className="ct-settings__row ct-settings__rowButton" aria-label={`${t('calendars.settingsRow')} : ${value}`} onClick={() => navigate({ tab: 'settings', screen: 'calendars' })}>
      <span>{t('calendars.settingsRow')}</span>
      <span className="ct-settings__value" style={accounts.length > 0 ? { color: 'var(--ct-color-achieved-text)' } : undefined}>
        {value}
      </span>
    </button>
  );
}
