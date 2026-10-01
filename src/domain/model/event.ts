import type { EventId, LocalDate, LocalTime, SpaceId, SyncMeta } from '../types';
import type { IconRef } from './icon';

export type EventKind = 'event' | 'birthday' | 'important';
export type EventRepeat = 'once' | 'monthly' | 'yearly';

/**
 * Événement interne (M7, ordre 2) — forme minimale posée à l'ordre 1 pour
 * l'affichage dans Aujourd'hui et Semaine (A-01). Sera complétée par
 * checklists-events sans casser ces champs.
 *
 * Colonnes `event.start` / `event.end` : 'YYYY-MM-DD' si `allDay`, sinon
 * 'YYYY-MM-DDTHH:mm' (heure locale flottante). Les événements externes (M8) sont
 * une autre table (`external_event`, UTC) et un autre type.
 */
export interface CalendarEvent extends SyncMeta {
  readonly id: EventId;
  readonly spaceId: SpaceId;
  readonly title: string;
  readonly startDate: LocalDate;
  readonly startTime: LocalTime | null;
  readonly endDate: LocalDate;
  readonly endTime: LocalTime | null;
  readonly allDay: boolean;
  readonly kind: EventKind;
  readonly repeat: EventRepeat;
  readonly important: boolean;
  readonly icon: IconRef | null;
  readonly birthYear: number | null;
}
