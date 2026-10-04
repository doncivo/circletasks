import { ArrowLeft, ArrowRight, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { parseLocalDate } from '../../domain/localDate';
import { formatPercent, monthAggregate, monthRate, type AggregateState } from '../../domain/routineReport';
import type { LocalDate, RoutineId } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { formatDayAria, weekdayInitials } from '../../i18n/format';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { Icon, SpacePills } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { DEFAULT_ROUTES, useNavigationStore } from '../app/navigation';
import { routinesStore } from './routineStore';
import './RoutinesMonthReport.css';

const EMPTY_DONE: ReadonlySet<LocalDate> = new Set();

type CellKey = 'cellAll' | 'cellPartial' | 'cellMissed' | 'cellUpcoming' | 'cellNone';
const CELL_KEYS: { readonly [S in AggregateState]: CellKey } = {
  all: 'cellAll',
  partial: 'cellPartial',
  missed: 'cellMissed',
  upcoming: 'cellUpcoming',
  none: 'cellNone',
};

/**
 * Vue mensuelle de toutes les routines (R-06 critère 6, QB-06) : bouton « Rapport du mois » de l'onglet Routines sur iPhone ;
 * section « ROUTINES — JOURS COMPLÉTÉS » de Rapport.html (carte du mois, une case par jour) et taux du mois par routine. Les routines
 * archivées comptent par leurs validations (R-05 critère 6). Rapport global (tâches, Focus, objectifs) : H-01.
 */
export function RoutinesMonthReport() {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const current = parseLocalDate(today);

  const routines = useFeatureStore(routinesStore, (s) => s.routines);
  const archived = useFeatureStore(routinesStore, (s) => s.archived);
  const doneByRoutine = useFeatureStore(routinesStore, (s) => s.doneByRoutine);
  const pausesOf = useFeatureStore(routinesStore, (s) => s.pausesOf);
  const status = useFeatureStore(routinesStore, (s) => s.status);
  const errorKey = useFeatureStore(routinesStore, (s) => s.errorKey);
  const load = useFeatureStore(routinesStore, (s) => s.load);
  const [month, setMonth] = useState({ year: current.year, month: current.month });

  useEffect(() => {
    void load(spaceFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter]);

  const firstWeekday = getFirstWeekday();
  const aggregate = useMemo(
    () => monthAggregate([...routines, ...archived], doneByRoutine, month.year, month.month, today, pausesOf, firstWeekday),
    [routines, archived, doneByRoutine, pausesOf, month, today, firstWeekday],
  );
  const rates = useMemo(
    () =>
      routines.map((routine) => ({
        routine,
        rate: monthRate(routine, doneByRoutine.get(routine.id as RoutineId) ?? EMPTY_DONE, month.year, month.month, today, pausesOf.get(routine.id as RoutineId) ?? []),
      })),
    [routines, doneByRoutine, pausesOf, month, today],
  );
  const atCurrentMonth = month.year === current.year && month.month === current.month;
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const monthName = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(month.year, month.month - 1, 1)));
  const heading = month.year === current.year ? monthName : `${monthName} ${String(month.year)}`;

  function shiftMonth(delta: -1 | 1): void {
    setMonth(({ year, month: m }) => {
      const index = year * 12 + (m - 1) + delta;
      const next = { year: Math.floor(index / 12), month: (index % 12) + 1 };
      return next.year * 12 + next.month > current.year * 12 + current.month ? { year, month: m } : next;
    });
  }

  return (
    <div className="ct-routines-month">
      <div className="ct-routines-month__topRow">
        <button type="button" className="ct-routines-month__iconButton" aria-label={t('routines.monthReport.back')} onClick={() => navigate(DEFAULT_ROUTES.routines)}>
          <Icon icon={Undo2} size={26} />
        </button>
      </div>
      <div className="ct-routines-month__headerRow">
        <div className="ct-routines-month__header">
          <span className="ct-routines-month__caption">{t('routines.monthReport.caption')}</span>
          <h1 className="ct-routines-month__title">{heading}</h1>
        </div>
        <div className="ct-routines-month__nav">
          <button type="button" className="ct-routines-month__iconButton" aria-label={t('routines.report.previousMonth')} onClick={() => shiftMonth(-1)}>
            <Icon icon={ArrowLeft} size={22} />
          </button>
          <button type="button" className="ct-routines-month__iconButton" aria-label={t('routines.report.nextMonth')} disabled={atCurrentMonth} onClick={() => shiftMonth(1)}>
            <Icon icon={ArrowRight} size={22} />
          </button>
        </div>
      </div>
      <div className="ct-routines-month__rule" aria-hidden="true">
        <div className="ct-routines-month__ruleAccent" />
        <div className="ct-routines-month__ruleLine" />
      </div>
      <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

      {status === 'error' && errorKey && (
        <p className="ct-routines-month__error" role="alert">
          {t(errorKey)}
        </p>
      )}

      <h2 className="ct-routines-month__section">{t('routines.monthReport.section')}</h2>
      <div className="ct-routines-month__grid" role="group" aria-label={t('routines.monthReport.section')}>
        {weekdayInitials().map((letter, index) => (
          <span key={index} className="ct-routines-month__weekday" aria-hidden="true">
            {letter}
          </span>
        ))}
        {Array.from({ length: aggregate.leadingBlanks }, (_, index) => (
          <span key={`blank-${String(index)}`} className="ct-routines-month__blank" aria-hidden="true" />
        ))}
        {aggregate.cells.map((cell) => (
          <div
            key={cell.date}
            role="img"
            aria-label={t(`routines.monthReport.${CELL_KEYS[cell.state]}`, { date: formatDayAria(cell.date), done: cell.done, planned: cell.planned })}
            className="ct-routines-month__cell"
            data-state={cell.state}
            data-today={cell.isToday}
            data-date={cell.date}
          >
            {cell.day}
          </div>
        ))}
      </div>

      {status === 'ready' && rates.length === 0 && <p className="ct-routines-month__empty">{t('routines.monthReport.empty')}</p>}
      {rates.length > 0 && (
        <ul className="ct-routines-month__rates" aria-label={t('routines.monthReport.ratesLabel')}>
          {rates.map(({ routine, rate }) => (
            <li key={routine.id} className="ct-routines-month__rate">
              <span className="ct-routines-month__rateTitle">{routine.title}</span>
              <span>{formatPercent(rate)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
