import { useEffect, useState } from 'react';
import { addDays } from '../../domain/localDate';
import { buildTodayList, rowTime, type TodayEventEntry, type TodayRow } from '../../domain/todayList';
import type { LocalDate, ProjectId, SpaceFilter } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import { formatTime, formatWeekDayHeader } from '../../i18n/format';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { tTodaySide } from '../../i18n/todaySideText';
import { Kbd } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { bandCountdownTag } from '../events/bandCountdown';
import { loadTodayExtras, subscribeToTodaySources } from './todaySources';
import './TodaySide.css';

export interface TodaySideProps {
  readonly today: LocalDate;
  readonly filter: SpaceFilter;
  readonly projectFilter: ProjectId | null;
  /** Change quand les tâches changent (identité de la carte des entités) : la colonne se relit. */
  readonly refreshKey: unknown;
  readonly onOpenShortcuts: () => void;
}

interface SideLine {
  readonly key: string;
  /** Colonne de gauche : heure, tiret, ou jour court (« ven. »). */
  readonly lead: string;
  readonly leadKind: 'time' | 'none' | 'day';
  readonly title: string;
  /** Compte à rebours d'un événement important (E-04) : « J-40 ». */
  readonly countdown: string | null;
}

interface SideData {
  readonly tomorrow: SideLine[];
  readonly week: SideLine[];
}

function rowLine(row: TodayRow, key: string, lead: { text: string; kind: SideLine['leadKind'] }): SideLine {
  return { key, lead: lead.text, leadKind: lead.kind, title: row.kind === 'task' ? row.task.title : row.routine.title, countdown: null };
}

function eventLine(event: TodayEventEntry, date: LocalDate, today: LocalDate, key: string, lead: { text: string; kind: SideLine['leadKind'] }): SideLine {
  const tag = bandCountdownTag(event, date, today);
  return { key, lead: lead.text, leadKind: lead.kind, title: event.title, countdown: tag?.label ?? null };
}

const timeLead = (time: string | null): { text: string; kind: SideLine['leadKind'] } => (time ? { text: formatTime(time), kind: 'time' } : { text: '—', kind: 'none' });
const dayLead = (date: LocalDate): { text: string; kind: SideLine['leadKind'] } => ({ text: formatWeekDayHeader(date).weekday.toLocaleLowerCase('fr-FR'), kind: 'day' });

/**
 * Seconde colonne d'Aujourd'hui sur PC (UI-REFONTE-08, PC-Jour.html) : « Demain » (heure ou tiret, titre), « Cette semaine » (jours
 * restants de la semaine : jour court, titre, compte à rebours des événements importants), « Raccourcis ». Lit les tâches et les
 * éléments des autres modules jour par jour (`listForDay`, `loadTodayExtras`) ; relue au changement de filtre, de jour, des tâches et
 * des sources. Bloc à la demande : rien ici n'est dans le bundle de départ.
 */
export function TodaySide({ today, filter, projectFilter, refreshKey, onOpenShortcuts }: TodaySideProps) {
  const container = useAppContainer();
  const [data, setData] = useState<SideData | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeToTodaySources(container, () => setVersion((n) => n + 1)), [container]);

  useEffect(() => {
    let alive = true;
    const tomorrow = addDays(today, 1);
    const weekEnd = addDays(weekStartOf(today, getFirstWeekday()), 6);
    const weekDays: LocalDate[] = [];
    for (let date = addDays(tomorrow, 1); date <= weekEnd; date = addDays(date, 1)) weekDays.push(date);

    const linesOf = async (date: LocalDate, lead: (time: string | null) => { text: string; kind: SideLine['leadKind'] }): Promise<SideLine[]> => {
      const all = await container.data.repos.tasks.listForDay(date, filter);
      const tasks = projectFilter ? all.filter((task) => task.projectId === projectFilter) : all;
      const { extras } = projectFilter ? { extras: { routines: [], events: [] } } : await loadTodayExtras(container, date, filter);
      const list = buildTodayList({ date, filter, tasks, routines: extras.routines, events: extras.events });
      return [
        ...list.events.map((event) => eventLine(event, date, today, `e-${event.id}`, lead(event.allDay ? null : event.startTime))),
        ...list.rows.map((row) => rowLine(row, `r-${row.id}`, lead(rowTime(row)))),
      ];
    };

    void (async () => {
      try {
        const tomorrowLines = await linesOf(tomorrow, timeLead);
        const week: SideLine[] = [];
        for (const date of weekDays) week.push(...(await linesOf(date, () => dayLead(date))));
        if (alive) setData({ tomorrow: tomorrowLines, week });
      } catch {
        // Aucun échec silencieux côté données : la colonne reste vide, l'écran principal porte déjà ses propres messages d'erreur.
        if (alive) setData({ tomorrow: [], week: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [container, today, filter, projectFilter, refreshKey, version]);

  const section = (title: string, lines: SideLine[] | undefined) => (
    <section className="ct-today-side__section">
      <h3 className="ct-today-side__title">{title}</h3>
      {lines === undefined ? null : lines.length === 0 ? (
        <p className="ct-today-side__empty">{tTodaySide('nothing')}</p>
      ) : (
        <ul className="ct-today-side__rows">
          {lines.map((line) => (
            <li key={line.key} className="ct-today-side__row">
              <span className="ct-today-side__lead" data-kind={line.leadKind}>
                {line.lead}
              </span>
              <span className="ct-today-side__text">
                {line.title}
                {line.countdown && <span className="ct-today-side__countdown"> · {line.countdown}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <aside className="ct-today__side" aria-label={tTodaySide('regionLabel')}>
      {section(tTodaySide('tomorrow'), data?.tomorrow)}
      {section(tTodaySide('thisWeek'), data?.week)}
      <section className="ct-today-side__section">
        <h3 className="ct-today-side__title">{tTodaySide('shortcuts')}</h3>
        <p className="ct-today-side__hints">
          <span>
            <Kbd keys="Ctrl+N" separator=" " /> {tTodaySide('hintNew')}
          </span>
          <span>
            <Kbd keys="Ctrl+K" separator=" " /> {tTodaySide('hintSearch')}
          </span>
          <button type="button" className="ct-today-side__hintButton" onClick={onOpenShortcuts}>
            <Kbd keys="Ctrl+/" separator=" " /> {tTodaySide('hintAll')}
          </button>
        </p>
      </section>
    </aside>
  );
}
