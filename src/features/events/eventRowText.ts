import type { EventListEntry } from '../../domain/eventList';
import { t } from '../../i18n';

/** Heures d'une ligne : « 10:00 – 11:00 », ou la seule heure de début quand la fin est la même ; null pour une journée entière. */
export function entryTimeRange(entry: Pick<EventListEntry, 'allDay' | 'startTime' | 'endTime'>): string | null {
  if (entry.allDay || entry.startTime === null) return null;
  return entry.endTime !== null && entry.endTime !== entry.startTime ? `${entry.startTime} – ${entry.endTime}` : entry.startTime;
}

export interface SubtitleOptions {
  /** Nom de l'espace, à écrire après le reste (sous « Tout » seulement) ; null : rien. */
  readonly spaceName: string | null;
}

/**
 * Sous-ligne d'une ligne d'événement (Evenements.html) : « 10:00 – 11:00 · Google Agenda », « Mensuel · Pro », « 09:30 · Pro »,
 * « Journée entière · Pro ». La répétition remplace « Journée entière » pour une série.
 */
export function entrySubtitle(entry: EventListEntry, options: SubtitleOptions): string {
  const parts: string[] = [];
  const range = entryTimeRange(entry);
  if (range) parts.push(range);
  const repeat = entry.event?.repeat ?? 'once';
  if (repeat === 'monthly') parts.push(t('events.repeatMonthly'));
  else if (repeat === 'yearly') parts.push(t('events.repeatYearly'));
  else if (!range) parts.push(t('events.allDay'));
  if (entry.calendarName) parts.push(entry.calendarName);
  if (options.spaceName) parts.push(options.spaceName);
  return parts.join(' · ');
}
