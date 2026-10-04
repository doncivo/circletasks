import { createHlcClock } from '../../domain/hlc';
import type { Task } from '../../domain/model';
import { asEntityId, type DeviceId, type LocalTime, type SpaceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createAppContainer, type AppContainer, type AppContainerParts } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';

/** Aides des tests du Focus (F-01 à F-04) : base en mémoire, horloge manuelle, conteneur, jeu de tâches. */
export interface FocusHarness {
  readonly db: TestDb;
  readonly container: AppContainer;
}

export const FOCUS_START = '2026-10-04T08:00:00.000Z';
export const MIN = 60_000;

export async function setupFocus(suffix: string, parts: Partial<AppContainerParts> = {}, startAt: string = FOCUS_START): Promise<FocusHarness> {
  const device = asEntityId<DeviceId>(`70000000-0000-4000-8000-0000000${suffix.padStart(5, '0')}`);
  const db = await openTestDb(device, startAt);
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: device }), data: db.data, ...parts });
  return { db, container };
}

/** Un conteneur « redémarré » : mêmes données, magasins neufs (l'app a été fermée puis rouverte). */
export function reopen(harness: FocusHarness, parts: Partial<AppContainerParts> = {}): AppContainer {
  return createAppContainer({ clock: harness.db.clock, hlc: harness.container.hlc, data: harness.db.data, ...parts });
}

export async function seedFocusTask(container: AppContainer, title = 'Envoyer la facture', over: { time?: string; spaceId?: SpaceId; date?: string } = {}): Promise<Task> {
  const created = await createTaskUseCases(container).create({
    title,
    spaceId: over.spaceId ?? SPACE_PRO_ID,
    date: (over.date ?? '2026-10-04') as never,
    ...(over.time ? { time: over.time as LocalTime } : {}),
  });
  if (!created.ok) throw new Error(`création impossible : ${created.error}`);
  return created.value;
}
