import { externalEventsByDay } from '../../domain/externalEvents';
import { addDays } from '../../domain/localDate';
import type { IsoDateTime } from '../../domain/types';
import { t } from '../../i18n';
import { detectTimeZone } from '../../platform';
import { useAppStore } from '../app/appStore';
import { onEventsChanged } from '../events/eventEvents';
import { sourceNames } from './sourceNames';
import { registerTodaySource, type TodaySource } from '../today/todaySources';

/**
 * Source des événements des agendas externes d'Aujourd'hui (K-03 critère 9, `registerTodaySource`, clé `external-events`, type
 * `TodayEventEntry`) : bandeaux #E3EEF5 avec la source, sans case, convertis dans le fuseau COURANT de l'appareil (T-11 : une journée
 * entière reste sur sa date) et filtrés par l'espace de leur agenda (ES-06). La Semaine ne la charge pas (`screens`) : elle lit les mêmes
 * lignes par son propre store (S-05) et ouvre leur fiche. `subscribe` relie les bandeaux aux rafraîchissements (K-03 critère 3).
 */
export const externalEventsTodaySource: TodaySource = {
  id: 'external-events',
  screens: ['today'],
  async load(container, date, filter) {
    // Une journée de marge de chaque côté : tous les fuseaux et les journées entières stockées en UTC.
    const range = { from: `${addDays(date, -1)}T00:00:00Z` as IsoDateTime, to: `${addDays(date, 2)}T00:00:00Z` as IsoDateTime };
    const [events, accounts] = await Promise.all([container.data.repos.externalEvents.listBetween(range), container.data.repos.calendarAccounts.listAll()]);
    if (events.length === 0) return {};
    const timeZone = useAppStore.getState().timeZone ?? detectTimeZone() ?? 'UTC';
    const byDay = externalEventsByDay({ days: [date], events, accounts, timeZone, filter, untitled: t('calendars.untitled'), sources: sourceNames() });
    return { events: byDay.get(date) ?? [] };
  },
  subscribe: (container, onChange) => onEventsChanged(container.data, onChange),
};

let unregister: (() => void) | null = null;

/** Branche les événements externes sur Aujourd'hui, une seule fois (appelé au démarrage de l'app). */
export function registerExternalEventsSource(): void {
  if (unregister) return;
  unregister = registerTodaySource(externalEventsTodaySource);
}

/** Retire la source (tests). */
export function unregisterExternalEventsSource(): void {
  unregister?.();
  unregister = null;
}
