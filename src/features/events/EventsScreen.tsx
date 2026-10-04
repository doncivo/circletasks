import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { buildEventList, dayDots, firstUpcomingEntry, groupByMonth, holidayEntries, isPastEntry } from '../../domain/eventList';
import { holidaysInRange, uncoveredLunarYears } from '../../domain/holidays';
import { makeLocalDate, parseLocalDate } from '../../domain/localDate';
import type { LocalDate, SpaceId } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { sourceNames } from '../calendars/sourceNames';
import { detectTimeZone } from '../../platform';
import { EmptyState, Fab, Icon, Sheet, SpacePills, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useEffectiveProjectFilter } from '../spaces';
import { AddSheet } from './AddSheet';
import { EventRow } from './EventRow';
import { EventsAgendasCard } from './EventsAgendasCard';
import { EventsMonthGrid } from './EventsMonthGrid';
import { entryTag } from './eventTags';
import { eventsStore } from './eventsStore';
import { enabledCountriesLabel, holidayName, holidaySubtitle } from './holidayText';
import { useStandaloneTaskSheet } from './useStandaloneTaskSheet';
import './EventsScreen.css';

const monthName = (year: number, month: number): string => new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));

/**
 * Onglet Événements (M7, Evenements.html, PC-Evenements.html) : la liste de l'année affichée (← 2026 →) par mois, événements locaux et
 * événements externes en lecture seule, passé grisé, ouverture sur aujourd'hui ; pastilles Pro / Perso / Tout ; « + » ouvre la feuille
 * Ajout au segment Événement. PC : volet droit avec la grille du mois et la carte des agendas ; iPhone : bouton « Calendrier ».
 */
export function EventsScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const openDetail = useNavigationStore((s) => s.openDetail);
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const appDay = useAppStore((s) => s.day);
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const projectFilter = useEffectiveProjectFilter();
  const today = appDay ?? todayLocal(container.clock);
  const todayYear = parseLocalDate(today).year;

  const events = useFeatureStore(eventsStore, (s) => s.events);
  const externalEvents = useFeatureStore(eventsStore, (s) => s.externalEvents);
  const accounts = useFeatureStore(eventsStore, (s) => s.accounts);
  const syncedAt = useFeatureStore(eventsStore, (s) => s.syncedAt);
  const holidayCountries = useFeatureStore(eventsStore, (s) => s.holidayCountries);
  const holidayRows = useFeatureStore(eventsStore, (s) => s.holidayRows);
  const status = useFeatureStore(eventsStore, (s) => s.status);
  const errorKey = useFeatureStore(eventsStore, (s) => s.errorKey);
  const load = useFeatureStore(eventsStore, (s) => s.load);

  const [year, setYear] = useState(todayYear);
  const [gridMonth, setGridMonth] = useState(parseLocalDate(today).month);
  const [selected, setSelected] = useState<LocalDate | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const taskSheet = useStandaloneTaskSheet(selected ?? today);

  useEffect(() => {
    void load(year, spaceFilter);
  }, [year, spaceFilter, load]);

  // Ctrl+N : nouvel événement (même raccourci que « nouvelle routine » dans l'onglet Routines).
  const openAdd = useCallback((): void => setAddOpen(true), []);
  useEffect(() => container.shortcuts.register('app.newTask', openAdd), [container, openAdd]);

  // Jours fériés des calendriers activés (E-03) : sans espace propre, donc visibles sous Pro, Perso et Tout.
  const holidays = useMemo(
    () => holidayEntries(holidaysInRange({ from: makeLocalDate(year, 1, 1), to: makeLocalDate(year, 12, 31), countries: holidayCountries, rows: holidayRows }), year, holidayName),
    [year, holidayCountries, holidayRows],
  );
  // Sous un filtre projet, aucun événement (E-01 critère 10).
  const entries = useMemo(
    () => (projectFilter ? [] : buildEventList({ year, events, externalEvents, accounts, timeZone, filter: spaceFilter, holidays, untitled: t('calendars.untitled'), sources: sourceNames() })),
    [year, events, externalEvents, accounts, timeZone, spaceFilter, projectFilter, holidays],
  );
  const uncovered = projectFilter ? [] : uncoveredLunarYears([year], holidayCountries);
  const holidayCountriesText = enabledCountriesLabel(holidayCountries);
  const groups = useMemo(() => groupByMonth(entries), [entries]);
  const dots = useMemo(() => dayDots(entries, year, gridMonth, spaces.map((space) => space.id as SpaceId)), [entries, year, gridMonth, spaces]);

  // Défilement de la liste seule (jamais de la page) : la première ligne datée de ce jour ou après vient en haut de la liste.
  const scrollToDate = useCallback((date: LocalDate): void => {
    const list = listRef.current;
    if (!list) return;
    const target = Array.from(list.querySelectorAll<HTMLElement>('[data-date]')).find((row) => (row.dataset['date'] ?? '') >= date);
    if (!target) return;
    // Première ligne de son mois : on aligne l'en-tête du mois (« SEPTEMBRE »), comme les maquettes.
    const anchor = target.closest('li')?.previousElementSibling === null ? (target.closest('section') ?? target) : target;
    const top = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    (list as Partial<HTMLElement>).scrollTo?.({ top, behavior: 'smooth' });
  }, []);

  // Ouverture positionnée sur aujourd'hui (E-01 critère 1) : une seule fois par année affichée.
  useEffect(() => {
    if (status !== 'ready' || year !== todayYear) return;
    const key = `${year}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const upcoming = firstUpcomingEntry(entries, today);
    if (upcoming) scrollToDate(upcoming.date);
  }, [status, year, todayYear, entries, today, scrollToDate]);

  function changeYear(delta: -1 | 1): void {
    setYear((current) => current + delta);
    setSelected(null);
  }

  function changeGridMonth(delta: -1 | 1): void {
    const next = gridMonth + delta;
    if (next < 1) {
      setYear(year - 1);
      setGridMonth(12);
    } else if (next > 12) {
      setYear(year + 1);
      setGridMonth(1);
    } else {
      setGridMonth(next);
    }
  }

  function selectDay(date: LocalDate): void {
    setSelected(date);
    setCalendarOpen(false);
    window.setTimeout(() => scrollToDate(date), 0);
  }

  const spaceNameOf = (spaceId: SpaceId | null): string | null => (spaceFilter === 'all' && spaceId !== null ? (spaces.find((space) => space.id === spaceId)?.name ?? null) : null);
  const grid = (
    <EventsMonthGrid year={year} month={gridMonth} today={today} spaces={spaces} dots={dots} selected={selected} onSelect={selectDay} onMonthChange={changeGridMonth} />
  );

  const list = (
    <div ref={listRef} className="ct-events__list" role="region" aria-label={t('events.listLabel')} tabIndex={-1}>
      {status === 'ready' && entries.length === 0 && (
        // Sous un filtre de projet, aucune action : un événement créé serait masqué par le filtre (P-06 critère 3).
        <EmptyState
          screen="events"
          title={projectFilter ? t('events.emptyProject') : t('events.empty', { year })}
          {...(projectFilter ? {} : { action: { label: t('empty.addEvent'), onClick: openAdd } })}
        />
      )}
      {groups.map((group) => (
        <section key={group.month} aria-labelledby={`ct-events-month-${group.month}`}>
          <h2 id={`ct-events-month-${group.month}`} className="ct-events__month">
            {monthName(year, group.month)}
          </h2>
          <ul className="ct-events__rows">
            {group.entries.map((entry) => {
              const local = entry.event;
              const holiday = entry.holiday;
              return (
                <EventRow
                  key={entry.key}
                  entry={entry}
                  today={today}
                  past={isPastEntry(entry, today)}
                  spaceName={entry.source === 'local' || (entry.source === 'external' && layout === 'pc') ? spaceNameOf(entry.spaceId) : null}
                  tag={entryTag(entry, today)}
                  selected={selected !== null && entry.date === selected}
                  {...(entry.holiday ? { subtitle: holidaySubtitle(entry.holiday) } : {})}
                  {...(local ? { onOpen: () => openDetail({ type: 'event', id: local.id }) } : {})}
                  {...(holiday ? { onOpen: () => openDetail({ type: 'holiday', country: holiday.country, key: holiday.key, year: holiday.year }) } : {})}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );

  const pane = (
    <div className="ct-events__pane">
      <div className="ct-events__headerRow">
        <h1 className="ct-events__title">{t('events.title')}</h1>
        <div className="ct-events__years">
          <button type="button" className="ct-events__arrow" aria-label={t('events.yearPrevious')} onClick={() => changeYear(-1)}>
            <Icon icon={ArrowLeft} />
          </button>
          <span className="ct-events__year" aria-live="polite">
            {year}
          </span>
          <button type="button" className="ct-events__arrow" aria-label={t('events.yearNext')} onClick={() => changeYear(1)}>
            <Icon icon={ArrowRight} />
          </button>
        </div>
      </div>
      <div className="ct-events__rule" aria-hidden="true">
        <div className="ct-events__ruleAccent" />
        <div className="ct-events__ruleLine" />
      </div>
      <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />
      {status === 'error' && errorKey && (
        <p className="ct-events__error" role="alert">
          {t(errorKey)}
        </p>
      )}
      {uncovered.map((missing) => (
        <p key={missing} className="ct-events__notice" role="status">
          {t('events.holidaySettings.uncovered', { year: missing })}
        </p>
      ))}
      {list}
      <div className="ct-events__bottomRow">
        {layout === 'mobile' && (
          <button type="button" className="ct-events__calendarButton" onClick={() => setCalendarOpen(true)}>
            {t('events.calendarButton')}
          </button>
        )}
        <Fab onClick={openAdd} label={layout === 'pc' ? t('events.addPc') : t('events.add')} />
      </div>
    </div>
  );

  return (
    <div className="ct-events" data-layout={layout}>
      {pane}
      {layout === 'pc' && (
        <aside className="ct-events__aside" aria-label={t('events.calendarLabel')}>
          {grid}
          <EventsAgendasCard
            accounts={accounts}
            spaces={spaces}
            syncedAt={syncedAt}
            nowMs={container.clock.nowMs()}
            holidaysLine={holidayCountriesText ? t('events.holidaysLine', { countries: holidayCountriesText }) : null}
            onOpenSettings={() => navigate({ tab: 'settings', screen: 'home' })}
          />
        </aside>
      )}
      {layout === 'mobile' && calendarOpen && (
        <Sheet open onClose={() => setCalendarOpen(false)} label={t('events.sheetCalendar.title')} className="ct-sheet--tall">
          <div className="ct-events__sheetHeader">
            <h2 className="ct-events__sheetTitle">{t('events.sheetCalendar.title')}</h2>
            <button type="button" className="ct-events__sheetClose" aria-label={t('events.sheetCalendar.close')} onClick={() => setCalendarOpen(false)}>
              <Icon icon={X} />
            </button>
          </div>
          {grid}
        </Sheet>
      )}
      {addOpen && <AddSheet initialSegment="event" date={selected ?? today} taskSheet={taskSheet} onClose={() => setAddOpen(false)} />}
    </div>
  );
}
