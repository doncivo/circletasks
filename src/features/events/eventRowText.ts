import type { EventListEntry } from '../../domain/eventList';
import { ageAtOccurrence } from '../../domain/eventKinds';
import { getLocale, t } from '../../i18n';

/** « 34 ans », « 1 an » (pluriel de la langue courante : en français, 0 et 1 au singulier). */
export function ageLabel(age: number): string {
  return t(new Intl.PluralRules(getLocale()).select(age) === 'one' ? 'events.ageOne' : 'events.ageMany', { count: age });
}

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
 * « Journée entière · Pro », « Annuel · 34 ans ». La répétition remplace « Journée entière » pour une série.
 */
export function entrySubtitle(entry: EventListEntry, options: SubtitleOptions): string {
  const parts: string[] = [];
  const range = entryTimeRange(entry);
  if (range) parts.push(range);
  const repeat = entry.event?.repeat ?? 'once';
  if (repeat === 'monthly') parts.push(t('events.repeatMonthly'));
  else if (repeat === 'yearly') parts.push(t('events.repeatYearly'));
  else if (!range) parts.push(t('events.allDay'));
  // Âge ou années écoulées (E-02 critères 2 à 4), seulement si l'année de naissance est renseignée, calculé sur l'année de la ligne.
  const age = entry.event ? ageAtOccurrence(entry.event, entry.date) : null;
  if (age !== null) parts.push(ageLabel(age));
  if (entry.calendarName) parts.push(entry.calendarName);
  if (options.spaceName) parts.push(options.spaceName);
  return parts.join(' · ');
}
