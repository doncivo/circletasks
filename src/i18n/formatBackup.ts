import type { BackupSummary } from '../domain/backupSchedule';
import { formatDayMonth, formatTime } from './format';
import { getLocale, t } from './index';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Date locale (« 3 oct. ») et heure (24 h par défaut, format choisi en P-03) d'un instant, dans le fuseau de l'appareil. */
export function formatBackupWhen(modifiedMs: number): { readonly date: string; readonly time: string } {
  const at = new Date(modifiedMs);
  const iso = `${String(at.getFullYear()).padStart(4, '0')}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return { date: formatDayMonth(iso), time: formatTime(`${pad2(at.getHours())}:${pad2(at.getMinutes())}`) };
}

/** Taille d'un fichier : « 48 Ko », « 1,2 Mo ». */
export function formatBackupSize(bytes: number): string {
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (bytes >= 1024 * 1024) return t('backup.sizeMb', { value: number.format(bytes / (1024 * 1024)) });
  return t('backup.sizeKb', { value: number.format(Math.max(1, Math.round(bytes / 1024))) });
}

/** Sous-ligne de « Sauvegarde automatique » : « Aujourd'hui 03:12 · 14 versions », « Hier 21:40 · 6 versions », « Aucune sauvegarde ». */
export function formatBackupSummary(summary: BackupSummary, failed: boolean): string {
  if (failed) return t('backup.summaryFailed');
  if (summary.kind === 'none') return t('backup.summaryNone');
  const when = formatBackupWhen(summary.modifiedMs);
  const one = summary.count === 1;
  if (summary.day === 'today') return one ? t('backup.summaryTodayOne', { time: when.time }) : t('backup.summaryToday', { time: when.time, count: summary.count });
  if (summary.day === 'yesterday') return one ? t('backup.summaryYesterdayOne', { time: when.time }) : t('backup.summaryYesterday', { time: when.time, count: summary.count });
  return one ? t('backup.summaryOtherOne', { date: when.date, time: when.time }) : t('backup.summaryOther', { date: when.date, time: when.time, count: summary.count });
}
