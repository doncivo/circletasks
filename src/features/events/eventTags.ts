import type { EventListEntry } from '../../domain/eventList';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import type { EventRowProps } from './EventRow';

/**
 * Étiquette d'une ligne de la liste (Evenements.html) : « Aujourd'hui » (#E3EEF5 / #1F6698) le jour même (E-01 critère 1). Les
 * étiquettes « J-n » (E-04) et « Férié » (E-03) s'y ajoutent.
 */
export function entryTag(entry: EventListEntry, today: LocalDate): EventRowProps['tag'] {
  if (entry.date <= today && entry.endDate >= today) return { label: t('events.tagToday'), kind: 'today' };
  return null;
}
