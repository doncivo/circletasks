import { countdownOf } from '../../domain/eventCountdown';
import type { EventListEntry } from '../../domain/eventList';
import type { LocalDate } from '../../domain/types';
import { countdownTag } from './countdownText';
import type { EventRowProps } from './EventRow';
import { holidayTagLabel } from './holidayText';

/**
 * Étiquette d'une ligne de la liste (Evenements.html) :
 * - jour férié : « Férié FR » (#E3EEF5) ou « Férié TN » (#E7F0EA), jamais de compte à rebours (E-03 critère 7) ;
 * - sinon le compte à rebours (E-04 critères 1, 2, 5, 8) : « Aujourd'hui » (#E3EEF5 / #1F6698) pendant l'événement, « J-12 » (#F3F1F6)
 *   avant, « J-2 » sur fond #FBE7E4 pour un anniversaire, rien une fois passé. La liste l'affiche sur tous les événements à venir,
 *   locaux ou d'agenda externe, important ou non (D1) ; chaque ligne d'une série compte vers sa propre date. Calculé avec « aujourd'hui »
 *   de l'appelant (horloge injectable) à chaque rendu : le tag change à minuit sans relancer l'app.
 */
export function entryTag(entry: EventListEntry, today: LocalDate): EventRowProps['tag'] {
  if (entry.holiday) return { label: holidayTagLabel(entry.holiday), kind: entry.holiday.country === 'FR' ? 'holidayFr' : 'holidayTn' };
  const days = countdownOf(entry, today);
  if (days === null) return null;
  const tag = countdownTag(days);
  const kind: NonNullable<EventRowProps['tag']>['kind'] = days === 0 ? 'today' : entry.event?.kind === 'birthday' ? 'birthday' : 'countdown';
  return { label: tag.label, kind, ...(tag.spoken ? { spoken: tag.spoken } : {}) };
}
