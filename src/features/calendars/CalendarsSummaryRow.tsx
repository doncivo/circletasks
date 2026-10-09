import { useEffect } from 'react';
import { t } from '../../i18n';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { appleRemindersState, appleRemindersStore } from './appleReminders/appleRemindersState';
import { calendarsStore } from './calendarsStore';

/**
 * Ligne « Agendas · Rappels Apple » de Réglages, section ESPACES ET CALENDRIERS (Reglages.html, K-01 critère 1 et D4, K-05 critère 8) :
 * « Aucun compte », « N agendas » (agendas affichés de tous les comptes), « M listes » (listes Rappels affichées, K-05) ou
 * « N agendas · M listes » ; elle ouvre l'écran Agendas. Sur le PC les listes viennent du réglage partagé reçu par la synchro.
 */
export function CalendarsSummaryRow() {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const load = useFeatureStore(calendarsStore, (s) => s.load);
  const accounts = useFeatureStore(calendarsStore, (s) => s.accounts);
  const lists = useFeatureStore(appleRemindersStore, (s) => s.lists);

  useEffect(() => {
    void load();
    void appleRemindersState(container).load();
  }, [load, container]);

  const shown = accounts.reduce((total, account) => total + account.calendars.filter((calendar) => calendar.shown).length, 0);
  const shownLists = lists.lists.filter((list) => list.shown).length;
  const agendas = accounts.length === 0 ? null : shown === 1 ? t('calendars.rowOne') : t('calendars.rowMany', { count: shown });
  const rappels = shownLists === 0 ? null : shownLists === 1 ? t('appleReminders.rowOneList') : t('appleReminders.rowLists', { count: shownLists });
  const parts = [agendas, rappels].filter((part): part is string => part !== null);
  const value = parts.length === 0 ? t('calendars.rowNone') : parts.join(' · ');
  const active = parts.length > 0;
  return (
    <button type="button" className="ct-settings__row ct-settings__rowButton" aria-label={`${t('calendars.settingsRow')} : ${value}`} onClick={() => navigate({ tab: 'settings', screen: 'calendars' })}>
      <span>{t('calendars.settingsRow')}</span>
      <span className="ct-settings__value" style={active ? { color: 'var(--ct-color-achieved-text)' } : undefined}>
        {value}
      </span>
    </button>
  );
}
