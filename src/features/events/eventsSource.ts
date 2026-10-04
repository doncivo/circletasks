import { holidayBands, todayEntriesForDay } from '../../domain/eventList';
import { holidaysInRange } from '../../domain/holidays';
import { registerTodaySource, type TodaySource } from '../today/todaySources';
import { onEventsChanged } from './eventEvents';
import { loadHolidayData } from './holidayUseCases';
import { holidayName, holidayTagLabel } from './holidayText';

/**
 * Source des événements d'Aujourd'hui et de la Semaine (E-01 critère 11, `registerTodaySource`, clé `events`, type `TodayEventEntry`) :
 * les occurrences d'événements locaux du jour, dans l'espace du filtre (le repository applique le filtre), et les jours fériés des
 * calendriers activés (E-03, lecture seule, sans espace). Les écrans masquent les événements sous un filtre de projet. `subscribe` relie les bandeaux aux écritures : une annulation (T-13) ou une modification
 * depuis la fiche met les bandeaux à jour sans recharger.
 */
export const eventsTodaySource: TodaySource = {
  id: 'events',
  async load(container, date, filter) {
    const events = await container.data.repos.events.listCandidatesForRange({ from: date, to: date }, filter);
    // Jours fériés (E-03 D5) : lecture seule, sans espace propre, donc visibles sous Pro, Perso et Tout.
    const holidayData = await loadHolidayData(container, date, date);
    const holidays = holidaysInRange({ from: date, to: date, countries: holidayData.countries, rows: holidayData.rows });
    return { events: [...holidayBands(holidays, holidayName, holidayTagLabel), ...todayEntriesForDay(events, date)] };
  },
  subscribe: (container, onChange) => onEventsChanged(container.data, onChange),
};

let unregister: (() => void) | null = null;

/** Branche la source d'événements sur Aujourd'hui et la Semaine, une seule fois (appelé au démarrage de l'app). */
export function registerEventsSource(): void {
  if (unregister) return;
  unregister = registerTodaySource(eventsTodaySource);
}

/** Retire la source (tests). */
export function unregisterEventsSource(): void {
  unregister?.();
  unregister = null;
}
