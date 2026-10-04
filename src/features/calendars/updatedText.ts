import { t } from '../../i18n';

/** « Mis à jour il y a 6 min » (K-03 critère 8) : « à l'instant » sous la minute, puis minutes, heures, jours ; « Pas encore mis à jour » sans réussite. */
export function formatUpdated(lastSuccessAt: string | null, nowMs: number): string {
  if (lastSuccessAt === null) return t('calendars.neverUpdated');
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(lastSuccessAt)) / 60_000));
  if (minutes < 1) return t('calendars.updatedNow');
  if (minutes < 60) return t('calendars.updatedMinutes', { minutes });
  if (minutes < 1440) return t('calendars.updatedHours', { hours: Math.floor(minutes / 60) });
  return t('calendars.updatedDays', { days: Math.floor(minutes / 1440) });
}
