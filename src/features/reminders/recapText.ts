import { activeRecapTimes, type Recap, type RecapSettings } from '../../domain/recap';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';

/** Titre d'un récapitulatif (N-04) : « 5 éléments aujourd'hui » / « 4 éléments non faits », « Tout est fait » si le soir est vide. */
export function formatRecapTitle(recap: Pick<Recap, 'kind' | 'count'>): string {
  if (recap.kind === 'morning') {
    if (recap.count === 0) return t('reminders.recapMorningEmpty');
    return recap.count === 1 ? t('reminders.recapMorningTitleOne') : t('reminders.recapMorningTitle', { count: recap.count });
  }
  if (recap.count === 0) return t('reminders.recapEveningEmpty');
  return recap.count === 1 ? t('reminders.recapEveningTitleOne') : t('reminders.recapEveningTitle', { count: recap.count });
}

/** Valeur de la ligne Réglages › Rappels › Récapitulatifs : « 07:30 · 21:00 », « Désactivés » si aucun n'est actif. */
export function formatRecapSummary(settings: RecapSettings): string {
  const times = activeRecapTimes(settings);
  return times.length === 0 ? t('reminders.recapsNone') : times.map(formatTime).join(' · ');
}
