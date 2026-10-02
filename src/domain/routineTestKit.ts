import type { Routine, RoutineLog } from './model';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type Hlc, type IsoDateTime, type LocalDate, type RoutineId, type RoutineLogId, type SpaceId } from './types';

/** Fabriques de routines et de validations pour les tests (domaine et écrans). Aucun code de production ne les importe. */

const STAMP = '2026-09-01T08:00:00.000Z' as IsoDateTime;
const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000003');
const SPACE = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
let counter = 0;

export function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  counter += 1;
  const n = String(counter).padStart(12, '0');
  return {
    id: asEntityId<RoutineId>(`80000000-0000-4000-8000-${n}`),
    spaceId: SPACE,
    title: 'Sport',
    icon: null,
    scheduleType: 'daily',
    weekdays: [],
    timesPerWeek: null,
    interval: null,
    startDate: asLocalDate('2026-01-01'),
    time: null,
    paused: false,
    archived: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    deviceId: DEVICE,
    hlc: '0000000000001-0000-test' as Hlc,
    ...overrides,
  };
}

export function makeLog(routine: Pick<Routine, 'id'>, date: string, overrides: Partial<RoutineLog> = {}): RoutineLog {
  counter += 1;
  const n = String(counter).padStart(12, '0');
  return {
    id: asEntityId<RoutineLogId>(`81000000-0000-4000-8000-${n}`),
    routineId: routine.id as RoutineId,
    date: asLocalDate(date),
    doneAt: `${date}T08:00:00.000Z` as IsoDateTime,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    deviceId: DEVICE,
    hlc: '0000000000001-0000-test' as Hlc,
    ...overrides,
  };
}

export const d = (iso: string): LocalDate => asLocalDate(iso);
export const time = (hhmm: string) => asLocalTime(hhmm);

/** Ensemble de dates validées. */
export const doneSet = (...dates: string[]): Set<LocalDate> => new Set(dates.map(asLocalDate));
