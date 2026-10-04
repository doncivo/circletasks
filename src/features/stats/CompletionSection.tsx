import { Component, lazy, Suspense, useId, useMemo, type ReactNode } from 'react';
import type { MonthReport, WeekBar } from '../../domain/monthReport';
import { t } from '../../i18n';
import { formatPercentLabel, formatWeekRange } from '../../i18n/formatStats';
import type { ChartBar } from './CompletionChart';

// H-02 critère 7 : Recharts n'est chargé qu'avec le rapport (import dynamique), jamais dans le paquet de départ.
const CompletionChart = lazy(() => import('./CompletionChart'));

function bubbleOf(bar: WeekBar): string {
  const week = bar.slot.number;
  const range = formatWeekRange(bar.slot.weekStart, bar.slot.weekEnd);
  return bar.total === 0 ? t('stats.chartTooltipNone', { week, range }) : t('stats.chartTooltip', { week, range, done: bar.done, total: bar.total });
}

/** Barres du graphique (étiquettes, bulle) construites depuis le rapport. */
export function chartBarsOf(report: MonthReport): ChartBar[] {
  return report.weeks.map((bar) => ({
    key: bar.slot.weekStart,
    label: t('stats.chartWeek', { week: bar.slot.number }),
    percent: bar.percent,
    valueLabel: formatPercentLabel(bar.percent),
    current: bar.slot.isCurrent,
    bubble: bubbleOf(bar),
  }));
}

/** Erreur de chargement du graphique : le tableau équivalent reste lisible. */
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <p className="ct-stats__error" role="alert">
        {t('stats.chartError')}
      </p>
    ) : (
      this.props.children
    );
  }
}

/**
 * Section « TAUX DE COMPLÉTION PAR SEMAINE » (H-02, Rapport.html) : titre et « Mois : 79 % » à droite, graphique Recharts, et tableau
 * équivalent masqué visuellement (« Semaine 37 : 84 %, 21 tâches sur 25 ») pour les lecteurs d'écran.
 */
export function CompletionSection({ report }: { report: MonthReport }) {
  const titleId = useId();
  const monthRate = report.tasks.percent;
  const bars = useMemo(() => chartBarsOf(report), [report]);
  return (
    <section className="ct-stats__chartBlock" aria-labelledby={titleId}>
      <div className="ct-stats__sectionRow">
        <h2 id={titleId} className="ct-stats__section">
          {t('stats.chartSection')}
        </h2>
        <span className="ct-stats__monthRate" data-testid="month-rate">
          {monthRate === null ? t('stats.chartMonthRateNone') : t('stats.chartMonthRate', { percent: monthRate })}
        </span>
      </div>
      <ChartBoundary>
        <Suspense fallback={<div className="ct-stats__chartLoading" aria-busy="true"><span className="ct-visually-hidden">{t('stats.chartLoading')}</span></div>}>
          <CompletionChart bars={bars} label={t('stats.chartLabel')} />
        </Suspense>
      </ChartBoundary>
      <table className="ct-visually-hidden">
        <caption>{t('stats.chartTableLabel')}</caption>
        <tbody>
          {report.weeks.map((bar) => (
            <tr key={bar.slot.weekStart}>
              <td>
                {bar.total === 0
                  ? t('stats.chartTableRowNone', { week: bar.slot.number })
                  : t(bar.done > 1 ? 'stats.chartTableRow' : 'stats.chartTableRowFew', { week: bar.slot.number, percent: bar.percent ?? 0, done: bar.done, total: bar.total })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
