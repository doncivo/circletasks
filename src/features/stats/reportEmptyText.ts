import type { MonthReport } from '../../domain/monthReport';
import { t } from '../../i18n';

/** Libellés communs à l'écran et à l'export ; un filtre n'est pas une absence de données. */
export function reportEmptyText(report: MonthReport) {
  const excluded = report.filter.project !== null;
  return {
    routines: excluded ? t('stats.excludedByProject') : report.routineRates.length > 0 ? t('stats.routinesUnscheduled') : t('stats.routinesEmpty'),
    goals: excluded ? t('stats.excludedByProject') : t('stats.goalsEmpty'),
  };
}
