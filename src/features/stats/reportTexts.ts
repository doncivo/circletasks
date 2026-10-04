import { focusTotalMinutes } from '../../domain/focusTotals';
import type { MonthReport } from '../../domain/monthReport';
import type { ReportTexts } from '../../domain/reportLayout';
import { t } from '../../i18n';
import { formatFocusDuration } from '../../i18n/formatFocus';
import { formatLongDate, formatPercentLabel, formatReportMonth } from '../../i18n/formatStats';
import { weekdayInitials } from '../../i18n/format';
import { chartBarsOf } from './CompletionSection';

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Textes du rapport exporté en image ou en PDF (H-03) : mêmes libellés que l'écran (tuiles, graphique, carte des routines), résolus
 * ici parce que le domaine (`reportLayout`) ne dépend pas de src/i18n.
 */
export function reportTextsOf(report: MonthReport, options: { readonly currentYear: number; readonly filterLabel: string; readonly today: string }): ReportTexts {
  const { tasks, routines, focus, goals } = report;
  const noValue = t('stats.noValue');
  const routinesPercent = routines?.percent ?? null;
  const bars = chartBarsOf(report);
  return {
    caption: t('stats.caption'),
    title: capitalize(formatReportMonth(report.month, options.currentYear)),
    filterLabel: t('stats.reportFilter', { filter: options.filterLabel }),
    tiles: [
      tasks.total > 0 ? { label: t('stats.tasksLabel'), value: String(tasks.done), sub: t('stats.tasksOf', { total: tasks.total }) } : { label: t('stats.tasksLabel'), value: noValue },
      { label: t('stats.routinesLabel'), value: formatPercentLabel(routinesPercent) },
      { label: t('stats.focusLabel'), value: formatFocusDuration(focusTotalMinutes(focus)) },
      goals ? { label: t('stats.goalsLabel'), value: String(goals.achieved), sub: t('stats.goalsOf', { total: goals.total }) } : { label: t('stats.goalsLabel'), value: noValue },
    ],
    chartTitle: t('stats.chartSection'),
    monthRate: tasks.percent === null ? t('stats.chartMonthRateNone') : t('stats.chartMonthRate', { percent: tasks.percent }),
    bars: bars.map((bar) => ({ label: bar.label, valueLabel: bar.valueLabel, percent: bar.percent, current: bar.current })),
    routinesTitle: t('routines.monthReport.section'),
    weekdays: weekdayInitials(),
    heatmap: report.heatmap ? { leadingBlanks: report.heatmap.leadingBlanks, cells: report.heatmap.cells.map((cell) => ({ day: cell.day, state: cell.state })) } : null,
    rates: report.routineRates.map((rate) => ({ title: rate.title, value: formatPercentLabel(rate.percent) })),
    footer: t('stats.reportFooter', { date: formatLongDate(options.today) }),
  };
}
