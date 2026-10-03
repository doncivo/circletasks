import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { undoMessage } from '../app/undo';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { seedTask } from '../today/testKit';
import { seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

describe('moveToSomeday : cas d’usage (SD-03)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('431');
  });
  afterEach(() => teardownSomeday(h));

  const titles = async () => (await h.container.data.repos.tasks.listSomeday('all')).map((task) => task.title);

  it('un lot garde son ordre relatif en tête de la liste, un seul message et une seule annulation', async () => {
    await seedSomeday(h, { title: 'Ancienne' });
    const a = await seedTask(h, { title: 'A', time: '09:00' });
    const b = await seedTask(h, { title: 'B' });
    await createTaskUseCases(h.container).moveToSomeday([a.id, b.id]);
    expect(await titles()).toEqual(['A', 'B', 'Ancienne']);
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('2 tâches mises dans « Un jour »');
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect(await titles()).toEqual(['Ancienne']);
    expect(await h.container.data.repos.tasks.getById(a.id)).toMatchObject({ someday: false, date: h.today, time: '09:00', sortOrder: a.sortOrder });
  });

  it('ignore une tâche terminée, récurrente ou déjà dans « Un jour » : rien n’est écrit ni annulable (critères 6 et 7)', async () => {
    const uc = createTaskUseCases(h.container);
    const done = await seedTask(h, { title: 'Faite' });
    await uc.complete(done.id);
    const created = await uc.create({ title: 'Récurrente', spaceId: done.spaceId, date: h.today, recurrence: defaultRecurrence('daily', h.today) });
    if (!created.ok) throw new Error('création');
    const already = await seedSomeday(h, { title: 'Déjà là' });
    h.container.undo.clear();
    expect(await uc.moveToSomeday([done.id, created.value.id, already.id])).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    expect(await h.container.data.repos.tasks.getById(created.value.id)).toMatchObject({ someday: false, date: h.today });
  });

  it('les rappels restent en base, intacts (QB-10)', async () => {
    const uc = createTaskUseCases(h.container);
    const created = await uc.create({ title: 'Appeler le notaire', spaceId: (await seedTask(h, { title: 'x' })).spaceId, date: h.today, time: '10:00' as never, reminderOffsets: [0, 30] });
    if (!created.ok) throw new Error('création');
    const target = { type: 'task', id: created.value.id } as const;
    const before = await h.container.data.repos.reminders.listForTarget(target);
    await uc.moveToSomeday([created.value.id]);
    expect(await h.container.data.repos.reminders.listForTarget(target)).toEqual(before);
  });
});
