import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID } from '../seed/defaultSpaces';
import { observeWrites } from './observeWrites';
import { openTestDb, type TestDb } from './sql/testSetup';

const DEVICE = asEntityId<DeviceId>('70000000-0000-4000-8000-0000000000a1');

/** Déclencheur `edit` de N-01 (ADR 0012 avenant N1.3) : toute écriture réussie d'un repository surveillé, après validation. */
describe('observeWrites', () => {
  let db: TestDb;
  let writes: number;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    writes = 0;
  });
  afterEach(() => db.close());

  const observed = () =>
    observeWrites(db.data, {
      watch: ['tasks', 'reminders', 'settings'],
      settingsKey: (key) => key.startsWith('reminders.'),
      onWrite: () => {
        writes += 1;
      },
    });

  const newTask = (id: string) => ({
    id: asEntityId<TaskId>(id),
    spaceId: SPACE_PERSO_ID,
    projectId: null,
    title: 'T',
    note: '',
    date: null,
    time: null,
    status: 'todo' as const,
    doneAt: null,
    sortOrder: 1,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local' as const,
    externalId: null,
    externalEventId: null,
  });

  it('une écriture réussie d’un repository surveillé déclenche, après validation ; une lecture jamais', async () => {
    const data = observed();
    const created = await data.repos.tasks.create(newTask('10000000-0000-4000-8000-0000000000a1'));
    expect(writes).toBe(1);
    await data.repos.tasks.getById(created.id);
    await data.repos.tasks.listForDay('2026-10-08' as never, 'all');
    await data.repos.tasks.listByIds([created.id]);
    await data.repos.reminders.listLive();
    expect(writes).toBe(1);
    await data.repos.tasks.complete(created.id, '2026-10-08T08:00:00.000Z' as never);
    expect(writes).toBe(2);
  });

  it('une écriture en échec ne déclenche pas', async () => {
    const data = observed();
    await expect(data.repos.tasks.update('10000000-0000-4000-8000-0000000000ff' as TaskId, { title: 'x' })).rejects.toThrow();
    expect(writes).toBe(0);
  });

  it('réglages : seules les clés des rappels déclenchent (jamais l’état des rappels lui-même)', async () => {
    const data = observed();
    await data.repos.settings.set('ui.theme', 'dark');
    await data.repos.settings.set('notifications.status', { v: 1 });
    await data.repos.settings.set('notifications.ledger', null);
    await data.repos.settings.get('reminders.morningRecap');
    expect(writes).toBe(0);
    await data.repos.settings.set('reminders.eveningRecap', { enabled: true, time: '21:30' as never });
    expect(writes).toBe(1);
  });

  it('les repositories non surveillés sont rendus tels quels', async () => {
    const data = observed();
    expect(data.repos.routines).toBe(db.data.repos.routines);
    await data.repos.spaces.listAll();
    expect(writes).toBe(0);
  });

  it('une transaction validée déclenche une fois, une transaction annulée jamais', async () => {
    const data = observed();
    await data.transaction(async (repos) => {
      await repos.tasks.create(newTask('10000000-0000-4000-8000-0000000000b1'));
      await repos.tasks.create(newTask('10000000-0000-4000-8000-0000000000b2'));
    });
    expect(writes).toBe(1);
    await expect(
      data.transaction(async (repos) => {
        await repos.tasks.create(newTask('10000000-0000-4000-8000-0000000000b3'));
        throw new Error('annulée');
      }),
    ).rejects.toThrow('annulée');
    expect(writes).toBe(1);
  });
});
