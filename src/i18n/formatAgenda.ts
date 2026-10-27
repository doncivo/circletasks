import type { LocalTime } from '../domain/types';
import { t } from './index';

/**
 * Textes de l'agenda du jour (UI-REFONTE-02, Jour.html) : retard d'une tâche due et libellé parlé de la ligne « maintenant ».
 */

/** « En retard de 32 min », « En retard de 2 h », « En retard de 1 h 50 » (minutes sur deux chiffres au-delà de l'heure). */
export function formatLate(minutes: number): string {
  if (minutes < 60) return t('today.lateMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return t('today.lateHours', { hours });
  return t('today.lateHoursMinutes', { hours, minutes: String(rest).padStart(2, '0') });
}

/** « Il est 14 h 32 » : heure parlée de la ligne « maintenant » (lecteurs d'écran), heures sans zéro de tête. */
export function formatNowLabel(time: LocalTime): string {
  return t('today.nowLabel', { time: `${Number(time.slice(0, 2))} h ${time.slice(3, 5)}` });
}
