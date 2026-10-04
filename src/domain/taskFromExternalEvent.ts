import { externalEventSpan } from './externalEvents';
import type { CalendarRef, ExternalEvent } from './model';
import { TASK_TITLE_MAX_LENGTH } from './taskRules';
import type { LocalDate, SpaceId } from './types';

/**
 * Tâche créée depuis un événement d'agenda externe (K-04) : titre de l'événement, DATE LOCALE de son premier jour (fuseau de l'appareil,
 * T-11 : une journée entière ou un séjour de plusieurs jours garde sa date, sans décalage), SANS heure (D2 : « même date », pas de copie
 * des heures, du lieu ni des participants), sans projet, dans l'espace de l'agenda (ES-06).
 */
export interface ExternalTaskDraft {
  readonly title: string;
  readonly date: LocalDate;
  /** Espace de l'agenda ; null si l'agenda n'est rattaché à aucun espace (l'appelant applique l'espace par défaut). */
  readonly spaceId: SpaceId | null;
}

/**
 * Brouillon de tâche d'un événement. `untitled` : titre d'une tâche tirée d'un événement sans titre (texte i18n fourni par l'appelant).
 * null si l'événement n'a pas de date lisible.
 */
export function taskFromExternalEvent(event: Pick<ExternalEvent, 'title' | 'allDay' | 'startUtc' | 'endUtc'>, calendar: Pick<CalendarRef, 'spaceId'> | null, timeZone: string, untitled: string): ExternalTaskDraft | null {
  const span = externalEventSpan(event, timeZone);
  if (!span) return null;
  const title = (event.title.trim() === '' ? untitled : event.title.trim()).slice(0, TASK_TITLE_MAX_LENGTH);
  return { title, date: span.firstDay, spaceId: calendar?.spaceId ?? null };
}
