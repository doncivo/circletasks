import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { externalEventRowId } from '../../../domain/calendarProvider';
import type { NewTask } from '../../../domain/model';
import { asEntityId, type CalendarAccountId, type DeviceId, type ExternalEventId, type IsoDateTime, type LocalDate, type TaskId } from '../../../domain/types';
import { SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000404');
const ACCOUNT = asEntityId<CalendarAccountId>('40000000-0000-4000-8000-000000000004');
const EVENT = externalEventRowId(ACCOUNT, 'cal', 'point-client');

const base = (id: string, patch: Partial<NewTask> = {}): NewTask => ({
  id: asEntityId<TaskId>(id),
  spaceId: SPACE_PRO_ID,
  projectId: null,
  title: 'Point client',
  note: '',
  date: '2026-09-23' as LocalDate,
  time: null,
  status: 'todo',
  doneAt: null,
  sortOrder: 1,
  carriedOver: false,
  recurrenceId: null,
  seriesIndex: null,
  seriesTemplate: null,
  goalId: null,
  icon: null,
  someday: false,
  source: 'local',
  externalId: null,
  appleListId: null,
  appleRecurring: false,
  externalEventId: null,
  ...patch,
});

describe('lien tâche → événement externe (K-04, SQL)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  it('la colonne est écrite à la création et relue, avec ou sans la ligne d’événement (aucune clé étrangère)', async () => {
    const created = await db.data.repos.tasks.create(base('10000000-0000-4000-8000-000000000001', { externalEventId: EVENT }));
    expect(created.externalEventId).toBe(EVENT);
    expect((await db.data.repos.tasks.getById(created.id))?.externalEventId).toBe(EVENT);
    expect(await db.data.repos.externalEvents.getById(EVENT)).toBeNull();
    const [other] = await db.data.repos.tasks.createMany([base('10000000-0000-4000-8000-000000000002', { externalEventId: EVENT })]);
    expect(other?.externalEventId).toBe(EVENT);
  });

  it('findByExternalEvent : la tâche vivante liée, la plus ancienne ; rien pour un autre événement, une copie écartée ou la corbeille', async () => {
    expect(await db.data.repos.tasks.findByExternalEvent(EVENT)).toBeNull();
    const first = await db.data.repos.tasks.create(base('10000000-0000-4000-8000-000000000001', { externalEventId: EVENT }));
    db.clock.advance(1000);
    await db.data.repos.tasks.create(base('10000000-0000-4000-8000-000000000002', { externalEventId: EVENT }));
    expect((await db.data.repos.tasks.findByExternalEvent(EVENT))?.id).toBe(first.id);
    expect(await db.data.repos.tasks.findByExternalEvent('autre|autre|autre' as ExternalEventId)).toBeNull();
    await db.data.repos.tasks.softDelete([first.id]);
    expect((await db.data.repos.tasks.findByExternalEvent(EVENT))?.id).toBe('10000000-0000-4000-8000-000000000002');
    await db.data.repos.tasks.discard([asEntityId<TaskId>('10000000-0000-4000-8000-000000000002')]);
    expect(await db.data.repos.tasks.findByExternalEvent(EVENT)).toBeNull();
    await db.data.repos.tasks.restore([first.id]);
    expect((await db.data.repos.tasks.findByExternalEvent(EVENT))?.id).toBe(first.id);
  });

  it('modifier, terminer ou déplacer la tâche garde le lien et ne touche pas l’événement (critère 7)', async () => {
    const created = await db.data.repos.tasks.create(base('10000000-0000-4000-8000-000000000001', { externalEventId: EVENT }));
    await db.data.repos.tasks.update(created.id, { title: 'Renommée', date: '2026-10-01' as LocalDate });
    await db.data.repos.tasks.complete(created.id, '2026-09-23T10:00:00.000Z' as IsoDateTime);
    expect(await db.data.repos.tasks.getById(created.id)).toMatchObject({ title: 'Renommée', externalEventId: EVENT, status: 'done' });
  });
});
