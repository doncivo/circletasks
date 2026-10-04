import { countdownOf } from '../../domain/eventCountdown';
import type { TodayEventEntry } from '../../domain/todayList';
import type { LocalDate } from '../../domain/types';
import { countdownTag, type CountdownTag } from './countdownText';

/**
 * Compte à rebours du bandeau d'un événement dans Aujourd'hui et la Semaine (E-04 critère 4) : seulement pour un événement LOCAL marqué
 * « important » (interrupteur « Compte à rebours ») ; jamais pour un événement non important, un événement d'agenda externe ni un jour
 * férié (critère 8). `date` est le jour où le bandeau s'affiche, `today` le jour courant de l'app (horloge injectable) : le bandeau d'un
 * anniversaire de vendredi affiche « J-2 » le mercredi, « Aujourd'hui » le vendredi, rien le samedi.
 */
export function bandCountdownTag(event: Pick<TodayEventEntry, 'important' | 'calendarName' | 'kind'>, date: LocalDate, today: LocalDate): CountdownTag | null {
  if (event.important !== true || event.calendarName !== null || event.kind === 'holiday') return null;
  const days = countdownOf({ date, endDate: date }, today);
  return days === null ? null : countdownTag(days);
}
