import { createStore } from 'zustand';
import { DEFAULT_HOLIDAY_COUNTRIES, type HolidayCountries } from '../../domain/holidays';
import { addDays, makeLocalDate } from '../../domain/localDate';
import type { CalendarAccount, CalendarEvent, ExternalEvent, Holiday } from '../../domain/model';
import type { IsoDateTime, SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { onEventsChanged } from './eventEvents';
import { loadHolidayData } from './holidayUseCases';

export type EventsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État de l'onglet Événements (M7). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Le store garde les données brutes de
 * l'année affichée (événements locaux et d'agendas externes, comptes) ; la liste, les points de la grille et les étiquettes se calculent
 * à l'affichage avec le domaine (fuseau et « aujourd'hui » courants). Il se relit quand un événement change, y compris par « Annuler ».
 */
export interface EventsState {
  readonly year: number | null;
  readonly filter: SpaceFilter;
  /** Événements locaux dont une occurrence peut tomber dans l'année. */
  readonly events: readonly CalendarEvent[];
  readonly externalEvents: readonly ExternalEvent[];
  readonly accounts: readonly CalendarAccount[];
  /** Calendriers de jours fériés activés (E-03, réglage `holidays.countries`) et lignes `holiday` des années lues (fêtes lunaires, saisies). */
  readonly holidayCountries: HolidayCountries;
  readonly holidayRows: readonly Holiday[];
  /** Dernière actualisation d'un agenda externe (la plus récente des lignes lues) ; null sans événement externe. */
  readonly syncedAt: IsoDateTime | null;
  readonly status: EventsStatus;
  readonly errorKey: PlainMessageKey | null;
  /** (Re)charge l'année pour le filtre d'espace. Ne rejette jamais. */
  load(year: number, filter: SpaceFilter): Promise<void>;
  /** Relit sans repasser par `loading` (une suppression annulée ailleurs). Ne rejette jamais. */
  refresh(): Promise<void>;
}

export const eventsStore = defineFeatureStore<EventsState>((container: AppContainer) => {
  // Jeton de requête : le résultat d'une lecture dépassée par une plus récente est ignoré (changement d'année rapide).
  let requestId = 0;

  const read = async (year: number, filter: SpaceFilter) => {
    const from = makeLocalDate(year, 1, 1);
    const to = makeLocalDate(year, 12, 31);
    const events = await container.data.repos.events.listCandidatesForRange({ from, to }, filter);
    // Agendas externes (K-03) : lecture seule ; un échec de lecture ne masque pas les événements locaux. Marge d'un jour de chaque côté
    // pour tous les fuseaux et les journées entières stockées en UTC.
    const [externalEvents, accounts]: [readonly ExternalEvent[], readonly CalendarAccount[]] = await Promise.all([
      container.data.repos.externalEvents.listBetween({ from: `${addDays(from, -1)}T00:00:00Z` as IsoDateTime, to: `${addDays(to, 2)}T00:00:00Z` as IsoDateTime }),
      container.data.repos.calendarAccounts.listAll(),
    ]).catch((): [readonly ExternalEvent[], readonly CalendarAccount[]] => [[], []]);
    const holidays = await loadHolidayData(container, from, to);
    const syncedAt = externalEvents.reduce<IsoDateTime | null>((latest, event) => (latest === null || event.syncedAt > latest ? event.syncedAt : latest), null);
    return { events, externalEvents, accounts, syncedAt, holidayCountries: holidays.countries, holidayRows: holidays.rows };
  };

  const store = createStore<EventsState>()((set, get) => ({
    year: null,
    filter: 'all',
    events: [],
    externalEvents: [],
    accounts: [],
    holidayCountries: DEFAULT_HOLIDAY_COUNTRIES,
    holidayRows: [],
    syncedAt: null,
    status: 'idle',
    errorKey: null,

    async load(year, filter) {
      const id = ++requestId;
      set({ status: 'loading', year, filter, errorKey: null });
      try {
        const data = await read(year, filter);
        if (id !== requestId) return;
        set({ ...data, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'events.loadError' });
      }
    },

    async refresh() {
      const { year, filter, status } = get();
      if (year === null || status === 'idle') return;
      const id = ++requestId;
      try {
        const data = await read(year, filter);
        if (id === requestId) set({ ...data, status: 'ready', errorKey: null });
      } catch {
        // Relecture discrète : l'affichage reste celui d'avant.
      }
    },
  }));

  onEventsChanged(container.data, () => void store.getState().refresh());
  return store;
});
