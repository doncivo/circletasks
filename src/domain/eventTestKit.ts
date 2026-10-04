import type { CalendarEvent } from './model';
import { asEntityId, asLocalDate, type DeviceId, type EventId, type Hlc, type IsoDateTime, type SpaceId } from './types';

/** Fabrique d'événements locaux pour les tests (domaine et écrans). Aucun code de production ne l'importe. */

const STAMP = '2026-09-01T08:00:00.000Z' as IsoDateTime;
const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000003');
const SPACE = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
let counter = 0;

type EventOverrides = Omit<Partial<CalendarEvent>, 'startDate' | 'endDate'> & { readonly startDate?: string; readonly endDate?: string };

/** Événement « journée entière » du 23 sept. 2026 par défaut ; `startDate` seul suffit pour un événement d'un jour. */
export function makeEvent(overrides: EventOverrides = {}): CalendarEvent {
  counter += 1;
  const n = String(counter).padStart(12, '0');
  const { startDate, endDate, ...rest } = overrides;
  const start = asLocalDate(startDate ?? '2026-09-23');
  return {
    id: asEntityId<EventId>(`92000000-0000-4000-8000-${n}`),
    spaceId: SPACE,
    title: 'Point client',
    startDate: start,
    startTime: null,
    endDate: endDate ? asLocalDate(endDate) : start,
    endTime: null,
    allDay: true,
    kind: 'event',
    repeat: 'once',
    important: false,
    icon: null,
    birthYear: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    deviceId: DEVICE,
    hlc: '0000000000001-0000-test' as Hlc,
    ...rest,
  };
}
