import type { PlanCoverage } from '../../domain/notificationPlan';
import { t } from '../../i18n';
import { formatDayMonth, formatTime } from '../../i18n/format';

/**
 * Couverture du plan de notifications (N-TECH-01 critère 21), lue par Réglages > Rappels (N-01) :
 * « Planifiés jusqu'au 12 nov. à 21:00 », « Tous les rappels sont planifiés », « Aucun rappel à planifier ».
 * La date et l'heure sont celles de l'échéance effective du dernier élément gardé (heure locale flottante, pas de conversion).
 */
export function formatCoverage(coverage: PlanCoverage): string {
  switch (coverage.state) {
    case 'complete':
      return t('reminders.coverageComplete');
    case 'empty':
      return t('reminders.coverageEmpty');
    case 'until': {
      const [day = '', time = ''] = coverage.until.split('T');
      return t('reminders.coverageUntil', { date: t('reminders.coverageDateTime', { day: formatDayMonth(day), time: formatTime(time) }) });
    }
  }
}
