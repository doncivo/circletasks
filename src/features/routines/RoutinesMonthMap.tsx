import type { Ref } from 'react';
import type { AggregateState, MonthAggregate } from '../../domain/routineReport';
import { t } from '../../i18n';
import { formatDayAria, weekdayInitials } from '../../i18n/format';
import { formatPercentLabel } from '../../i18n/formatStats';
import './RoutinesMonthMap.css';

type CellKey = 'cellAll' | 'cellPartial' | 'cellMissed' | 'cellUpcoming' | 'cellNone';
const CELL_KEYS: { readonly [S in AggregateState]: CellKey } = {
  all: 'cellAll',
  partial: 'cellPartial',
  missed: 'cellMissed',
  upcoming: 'cellUpcoming',
  none: 'cellNone',
};

export interface RoutineRateItem {
  readonly id: string;
  readonly title: string;
  readonly percent: number | null;
}

export interface RoutinesMonthMapProps {
  readonly aggregate: MonthAggregate;
  readonly rates: readonly RoutineRateItem[];
  /** Titre de section (pour faire défiler l'écran jusqu'aux routines, H-01 critère 10). */
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * Section « ROUTINES — JOURS COMPLÉTÉS » de Rapport.html (R-06) : carte du mois, une case par jour, puis le taux du mois de chaque
 * routine. Partagée par la vue mensuelle des routines et par le rapport du mois (H-01).
 */
export function RoutinesMonthMap({ aggregate, rates, headingRef }: RoutinesMonthMapProps) {
  return (
    <>
      <h2 ref={headingRef} className="ct-routines-month__section" tabIndex={-1}>
        {t('routines.monthReport.section')}
      </h2>
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
      {rates.length > 0 && (
        <ul className="ct-routines-month__rates" aria-label={t('routines.monthReport.ratesLabel')}>
          {rates.map((rate) => (
            <li key={rate.id} className="ct-routines-month__rate">
              <span className="ct-routines-month__rateTitle">{rate.title}</span>
              <span>{formatPercentLabel(rate.percent)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
